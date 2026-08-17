/**
 * ガントチャート協調編集クライアント (Phase 2-A)
 * ============================================
 * Phase 2-A 変更点:
 *   - ログイン認証連携（未ログイン時はログイン画面へリダイレクト）
 *   - WebSocket接続時に認証情報（sessionId, displayName）を送信
 *   - プレゼンスバーにログインユーザー名を表示
 *
 * このファイルは gantt HTML の </body> 直前で読み込まれる。
 */

/* ================================================================
   [Phase A] グローバル設定オブジェクト
   ================================================================
   - 各ページ・各モジュールから参照する URL / API パスを一箇所に集約。
   - window.__APP_BASE__(HTML 側で定義) を優先し、未定義時は '/WebGantt/'。
   - この値を書き換えるだけで、デプロイ先パスを切り替え可能。
   - 既存の CONFIG(下部) は温存。将来的に本オブジェクトへ順次移行する。
   ================================================================ */
(function initGanttConfig() {
  var base = (typeof window !== 'undefined' && window.__APP_BASE__)
    ? window.__APP_BASE__ : '/WebGantt/';

  // 末尾スラッシュを正規化
  if (base.charAt(base.length - 1) !== '/') base = base + '/';

  window.__GANTT_CONFIG__ = window.__GANTT_CONFIG__ || {
    BASE:          base,
    AUTH_API:      base + 'api/auth.php',
    PROJECTS_API:  base + 'api/projects.php',
    NOTIF_API:     base + 'api/notifications.php',
    USER_VIEW_API: base + 'api/user_view_settings.php',
    HEALTH_API:    base + 'api/health.php',
    LOGIN_URL:     base + 'login.html',
    PROJECTS_URL:  base + 'projects.html',
    ACCOUNT_URL:   base + 'account.html',
    GANTT_URL:     base + 'gantt/gantt-collab.html',
    WS_PATH:       '/ws/socket.io',
    SOCKET_IO_CDN: 'https://cdn.socket.io/4.7.5/socket.io.min.js',
  };
})();

(function () {
  'use strict';

  /* ================================================================
     0. 設定
  ================================================================ */

  /**
   * URLの ?project= パラメータからプロジェクトIDを取得。
   * パラメータがない場合は null を返す（後でロビーIDに差し替え）。
   */
  function getProjectIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('project') || null;
  }

  const CONFIG = {
    // Socket.IO は host のみ指定し、path で /ws を経由させる
    // （namespace として解釈されないよう io(url, {path}) 形式を使用）
    WS_URL:      (window.location.protocol === 'https:' ? 'https:' : 'http:') + '//' + window.location.host,
    WS_PATH:     '/ws/socket.io',
    WS_URL_FALLBACK: null,
    PROJECT_ID:  getProjectIdFromUrl() || 'project-demo-01', // 後でロビーIDで上書き
    USER_ID:     'user-' + Math.random().toString(36).slice(2, 7),
    DISPLAY_NAME: 'ゲスト',
    AUTH_API:    '/WebGantt/api/auth.php',
    LOGIN_URL:   '/WebGantt/login.html',

    RECONNECT_DELAY:   3000,
    SNAPSHOT_DEBOUNCE: 2000,
    LOG_ENABLED:       true,
  };

  /* ================================================================
     1. ユーティリティ
  ================================================================ */
  function log(...args) {
    if (CONFIG.LOG_ENABLED) console.log('[Collab]', ...args);
  }
  function warn(...args) {
    console.warn('[Collab]', ...args);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  const SESSION_ID = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

  // ── ナビゲーション管理（beforeunloadキャンセル時の再接続用） ──
  let _navigatingTo = null;       // 遷移先URL
  let _navigationAttempted = false; // ナビゲーション試行フラグ
  let _isLogoutNavigation = false;  // ログアウト遷移フラグ
  let _beforeUnloadHandlerInstalled = false;

  /* ================================================================
     2. 認証 (Phase 2-A)
  ================================================================ */

  // 認証状態
  let authUser = null;  // { id, username, displayName, role }
  let authSessionId = null;

  /**
   * 現在のユーザー情報をAPIから取得
   * 未ログインの場合はログイン画面へリダイレクト
   */
  async function checkAuth() {
    try {
      const res = await fetch(CONFIG.AUTH_API + '?action=me', { credentials: 'include' });
      const data = await res.json();

      if (data.authenticated && data.user) {
        authUser = data.user;
        authSessionId = data.sessionId || null;
        CONFIG.USER_ID = authUser.username;
        CONFIG.DISPLAY_NAME = authUser.displayName;
        log('認証済み:', authUser.username, '(', authUser.displayName, ')');

        // Phase 5-3: 通知モジュールを再アクティベート（認証前に init() されていた場合の対策）
        if (window.__notificationModule && typeof window.__notificationModule.reactivate === 'function') {
          window.__notificationModule.reactivate();
        }

        // URLに ?project= パラメータがない場合のプロジェクト決定
        // 優先順位: sessionStorage(直前のPJ) > user_login_project(設定済PJ) > ロビーPJ
        if (!getProjectIdFromUrl()) {
          // 1. sessionStorage から直前に見ていたプロジェクトを復元
          let lastProject = null;
          try { lastProject = sessionStorage.getItem('gantt_last_project'); } catch (err) {}
          if (lastProject) {
            // アクセス権があるかAPIで確認（権限がない場合はフォールバック）
            const hasAccess = await checkProjectAccess(lastProject);
            if (hasAccess) {
              CONFIG.PROJECT_ID = lastProject;
              const url = new URL(window.location.href);
              url.searchParams.set('project', CONFIG.PROJECT_ID);
              window.history.replaceState(null, '', url.toString());
              log('直前のプロジェクトを復元:', CONFIG.PROJECT_ID);
            } else {
              sessionStorage.removeItem('gantt_last_project');
              await applyLoginOrLobbyProjectId();
            }
          } else {
            await applyLoginOrLobbyProjectId();
          }
        }

        return true;
      } else {
        // 未ログイン → ログイン画面へリダイレクト
        log('未ログイン。ログイン画面へリダイレクト');
        // sessionStorage をクリア（再ログイン時に前回のプロジェクトが残らないように）
        try { sessionStorage.removeItem('gantt_last_project'); } catch (err) {}
        const currentUrl = window.location.pathname + window.location.search;
        window.location.href = CONFIG.LOGIN_URL + '?redirect=' + encodeURIComponent(currentUrl);
        return false;
      }
    } catch (err) {
      warn('認証チェックエラー:', err);
      // APIが利用できない場合はゲストとして続行（後方互換）
      log('API未応答。ゲストとして続行');
      return true;
    }
  }

  /**
   * ロビープロジェクトIDをAPIから取得し CONFIG.PROJECT_ID に適用する。
   * URLにプロジェクト指定がない場合（直接ガントページを開いた場合）に呼び出す。
   */
  async function applyLobbyProjectId() {
    try {
      const res = await fetch('/WebGantt/api/projects.php?action=lobby', { credentials: 'include' });
      const data = await res.json();
      if (data.lobby_project_id) {
        CONFIG.PROJECT_ID = data.lobby_project_id;
        log('ロビープロジェクトに接続:', CONFIG.PROJECT_ID);
        // URLをロビーIDで書き換え（ブラウザ履歴には残さない）
        const url = new URL(window.location.href);
        url.searchParams.set('project', CONFIG.PROJECT_ID);
        window.history.replaceState(null, '', url.toString());
      }
    } catch (err) {
      warn('ロビープロジェクトID取得エラー:', err);
      // フォールバック: そのまま project-demo-01 を使用
    }
  }

  /**
   * ログイン時表示プロジェクト または ロビープロジェクトを適用する。
   * 優先順位: user_login_project(設定済PJ) > ロビーPJ
   */
  async function applyLoginOrLobbyProjectId() {
    try {
      // 1. ユーザーが設定したログイン時表示プロジェクトを取得
      const res = await fetch('/WebGantt/api/projects.php?action=loginProject', { credentials: 'include' });
      const data = await res.json();
      if (data.project_id) {
        CONFIG.PROJECT_ID = data.project_id;
        log('ログイン時表示プロジェクトに接続:', CONFIG.PROJECT_ID);
        const url = new URL(window.location.href);
        url.searchParams.set('project', CONFIG.PROJECT_ID);
        window.history.replaceState(null, '', url.toString());
        return;
      }
      // 2. ロビープロジェクトにフォールバック
      await applyLobbyProjectId();
    } catch (err) {
      warn('ログイン時表示プロジェクト取得エラー:', err);
      // フォールバック: ロビープロジェクト
      await applyLobbyProjectId();
    }
  }

  /**
   * 指定プロジェクトへのアクセス権があるか確認する。
   */
  async function checkProjectAccess(projectId) {
    try {
      const res = await fetch('/WebGantt/api/projects.php', { credentials: 'include' });
      const data = await res.json();
      if (data.projects) {
        return data.projects.some(p => p.project_id === projectId);
      }
      return false;
    } catch (err) {
      warn('プロジェクトアクセス権確認エラー:', err);
      return false;
    }
  }

  /* ================================================================
     3. socket.io クライアントの動的ロード
  ================================================================ */
  let _socketLoadPromise = null;

  function loadSocketIO() {
    if (_socketLoadPromise) return _socketLoadPromise;
    _socketLoadPromise = new Promise((resolve, reject) => {
      if (window.io) { resolve(window.io); return; }
      const s = document.createElement('script');
      s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
      s.onload  = () => resolve(window.io);
      s.onerror = () => reject(new Error('socket.io-client の読み込みに失敗しました'));
      document.head.appendChild(s);
    });
    return _socketLoadPromise;
  }

  /* ================================================================
     4. 接続・切断管理
  ================================================================ */
  let socket      = null;
  let connected   = false;
  let serverVersion = 0;

  function makeAuthObject() {
    return {
      userId:      CONFIG.USER_ID,
      sessionId:   SESSION_ID,
      displayName: CONFIG.DISPLAY_NAME,
      authToken:   authSessionId,  // Phase 2-A: 認証セッションID
    };
  }

  async function connect() {
    try {
      const ioLib = await loadSocketIO();
      const authObj = makeAuthObject();

      try {
        socket = ioLib(CONFIG.WS_URL, {
          path:            CONFIG.WS_PATH,
          transports:     ['websocket', 'polling'],
          reconnection:   true,
          reconnectionDelay: CONFIG.RECONNECT_DELAY,
          timeout:         5000,
          auth: authObj,
        });
      } catch (e) {
        log('リバースプロキシ接続エラー:', e.message);
        throw e;
      }

      let primaryFailed = false;
      socket.on('connect_error', (err) => {
        if (!primaryFailed) {
          primaryFailed = true;
          log('WebSocket接続エラー:', err.message);
          // フォールバック廃止: 再接続はSocket.IOの自動再接続機能に委ねる
        }
      });

      registerSocketHandlers(socket);
      log('接続開始:', CONFIG.WS_URL, 'project:', CONFIG.PROJECT_ID, 'user:', CONFIG.USER_ID);
    } catch (err) {
      warn('接続失敗:', err);
      showToast('⚠️ サーバーへの接続(同期)に失敗しました', 'error');
    }
  }

  function registerSocketHandlers(s) {
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.on('connect_error', onConnectError);
    s.on('op_broadcast',       onOpBroadcast);
    s.on('full_sync',          onFullSync);
    s.on('full_sync_required', onFullSync);
    s.on('presence_update',    onPresenceUpdate);
    // 新規参加者からのスナップショット送信依頼
    s.on('snapshot_request',   onSnapshotRequest);
    // Phase 2-C: ユーザー参加/離脱通知
    s.on('user_join',          onUserJoin);
    s.on('user_leave',         onUserLeave);
    // Phase 3: 競合検出・編集ロック通知
    s.on('conflict_detected',  onConflictDetected);
    s.on('task_locked',        onTaskLocked);
    s.on('task_unlocked',      onTaskUnlocked);
    s.on('dep_locked',         onDepLocked);
    s.on('dep_unlocked',       onDepUnlocked);
    s.on('ann_locked',         onAnnLocked);
    s.on('ann_unlocked',       onAnnUnlocked);
    // Phase 4: 他ユーザーの選択同期
    s.on('remote_select',      onRemoteSelect);
    // Phase 5-1: リアルタイム通知受信
    s.on('notification_received', (notif) => {
      document.dispatchEvent(new CustomEvent('gantt:notification', { detail: notif }));
    });
  }

  function onConnect() {
    connected = true;
    log('接続完了 socket:', socket.id);
    UI.setStatus('connected');

    socket.emit('join_project', {
      projectId:   CONFIG.PROJECT_ID,
      userId:      CONFIG.USER_ID,
      displayName: CONFIG.DISPLAY_NAME,
      authToken:   authSessionId,
    }, (res) => {
      if (res.error) {
        warn('join_project エラー:', res.error);
        // Phase 2-B: アクセス権限エラーの場合
        if (res.code === 'ACCESS_DENIED') {
          UI.setStatus('error');
          showToast('⛔ このプロジェクトにアクセスする権限がありません', 'error', 10000);
          // 接続を切断
          if (socket) {
            socket.disconnect();
            connected = false;
          }
          // プロジェクト管理ページへ誘導
          setTimeout(() => {
            if (confirm('このプロジェクトにアクセスする権限がありません。\nプロジェクト管理ページへ移動しますか？')) {
              window.location.href = '/WebGantt/projects.html';
            }
          }, 1500);
        }
        return;
      }
      serverVersion = res.version;
      log(`参加完了 v${serverVersion} color:${res.color} project:${CONFIG.PROJECT_ID}`);
      log(`join_projectレスポンス: snapshot=${res.snapshot ? 'あり' : 'なし'} version=${res.version}`);
      if (res.snapshot) {
        const s = res.snapshot;
        log(`  snapshot内容: project=${s.project ? 'OK' : 'NG'} rows=${Array.isArray(s.rows) ? s.rows.length : 'NG'} tasks=${Array.isArray(s.tasks) ? s.tasks.length : 'NG'}`);
      }
      UI.setMyColor(res.color);

      if (!res.snapshot) {
        log('snapshotなし → sendSnapshot()で自分のデータを送信');
        sendSnapshot();
      } else {
        log('snapshotあり → applyRemoteSnapshot()でローカルに適用');
        applyRemoteSnapshot(res.snapshot, res.version);
        // Phase 2-C: 差分同期 — スナップショット以降の未適用操作を順次適用
        if (res.pendingOps && res.pendingOps.length > 0) {
          log(`差分ops適用開始: ${res.pendingOps.length}件 (v${res.version - res.pendingOps.length} → v${res.version})`);
          res.pendingOps.forEach(op => {
            if (op.sessionId !== SESSION_ID) {
              applyRemoteOp(op);
            }
          });
          serverVersion = res.version;
          log('差分ops適用完了 v', serverVersion);
        }
      }
    });
  }

  function onDisconnect(reason) {
    connected = false;
    log('切断:', reason);
    UI.setStatus('disconnected');
    showToast('🔌 接続が切れました。再接続中…', 'warning');
  }

  function onConnectError(err) {
    warn('接続エラー:', err.message);
    UI.setStatus('error');
  }

  /* ================================================================
     5. 操作の送受信
  ================================================================ */

  const opQueue = [];

  function sendOp(type, payload) {
    const op = { type, payload };
    if (!connected || !socket) {
      opQueue.push(op);
      log('キュー追加 (未接続):', type, opQueue.length);
      return;
    }
    _sendOpNow(op);
  }

  function _sendOpNow(op) {
    socket.emit('task_op', {
      projectId:   CONFIG.PROJECT_ID,
      sessionId:   SESSION_ID,
      baseVersion: serverVersion,
      op,
    }, (res) => {
      if (res.error) {
        warn('task_op エラー:', res.error);
        if (res.needFullSync) {
          socket.emit('request_full_sync', { projectId: CONFIG.PROJECT_ID });
        }
        return;
      }
      serverVersion = res.version;
      sendSnapshot();
    });
  }

  function flushQueue() {
    while (opQueue.length > 0 && connected) {
      const op = opQueue.shift();
      log('キューフラッシュ:', op.type);
      _sendOpNow(op);
    }
  }

  /* ================================================================
     6. リモート操作の受信・適用
  ================================================================ */

  // Phase 2-C: 通知の過剰表示を防ぐためのデバウンス
  let _notifyTimer = null;
  let _notifyQueue = [];

  function flushNotifyQueue() {
    if (_notifyQueue.length === 0) return;
    // キューに溜まった通知を1つにまとめる
    if (_notifyQueue.length === 1) {
      const item = _notifyQueue[0];
      showToast(item.message, item.type, 3000);
    } else {
      // 複数件ある場合は件数をまとめる
      const lastItem = _notifyQueue[_notifyQueue.length - 1];
      showToast(`${lastItem.message} 他${_notifyQueue.length - 1}件`, 'info', 3000);
    }
    _notifyQueue = [];
    _notifyTimer = null;
  }

  function queueNotification(message, type = 'info') {
    _notifyQueue.push({ message, type });
    if (_notifyTimer) clearTimeout(_notifyTimer);
    _notifyTimer = setTimeout(flushNotifyQueue, 800);
  }

  // 操作タイプの日本語化（通知用）
  const _opNotifyLabels = {
    'task_add':    'タスクを追加',
    'task_edit':   'タスクを編集',
    'task_move':   'タスクを移動',
    'task_delete': 'タスクを削除',
    'task_reorder':'タスクを並べ替え',
    'dep_add':     '矢印線を追加',
    'dep_delete':  '矢印線を削除',
    'dep_edit':    '依存関係編集',
    'status_change':'ステータス変更',
    'state_sync':  '状態同期',
    'resync':      '再同期',
  };

  // state_sync の subtype → 表示ラベル
  const _stateSyncSubtypeLabels = {
    'project_title':    'プロジェクト名編集',
    'dep_style':        '矢印線スタイル変更',
    'status_propagate': 'ステータス伝播',
    'delete_promote':   'タスクを子繰り上げ削除',
    'batch_lock':       '一括日付ロックを実行',
    'batch_anchor':     '一括バー固定を実行',
    'batch_memo':       '一括メモ追記',
    'batch_color':      '一括色変更',
    'cut':              '切り取り',
    'paste':            '貼り付け',
    'promote':          '階層を上げるを実行',
    'demote':           '階層を下げるを実行',
    'archive':          'アーカイブ',
    'restore':          'アーカイブ復元',
    'undo':             '取り消しを実行',
    'redo':             'やり直しを実行',
    'import':           'インポート',
    'calendar_import':  '外部カレンダーからインポート',
    'office_calendar_import': '外部カレンダーからインポート',
    'holiday':          '祝日(休日)を設定',
    'system_setting':   'システム設定を変更',
    'annotation':       '引き出し線注記操作',
  };

  function onOpBroadcast(serverOp) {
    if (serverOp.sessionId === SESSION_ID) return;
    log('受信:', serverOp.type, `v${serverOp.version}`);
    serverVersion = Math.max(serverVersion, serverOp.version);
    applyRemoteOp(serverOp);

    // Phase 2-C: 他ユーザーの操作を通知
    // state_sync の場合は subtype でより詳細なラベルを選択
    let opLabel;
    if (serverOp.type === 'state_sync' && serverOp.payload?.subtype) {
      opLabel = _stateSyncSubtypeLabels[serverOp.payload.subtype] || '状態同期';
    } else {
      opLabel = _opNotifyLabels[serverOp.type] || serverOp.type;
    }
    const userName = serverOp.displayName || '他のユーザー';
    // 詳細情報を抽出
    let detail = '';
    if (serverOp.payload) {
      if (serverOp.payload.taskName) detail = `「${serverOp.payload.taskName}」`;
      else if (serverOp.payload.name) detail = `「${serverOp.payload.name}」`;
    }
    const notifyMsg = `${userName}さんが${opLabel}${detail ? ': ' + detail : ''}しました`;
    queueNotification(notifyMsg, 'info');
    // Phase 4: ライブ変更フィードに追加
    appendToFeed(notifyMsg, '#a5d6a7', opLabel);
  }

  function onUserJoin(data) {
    if (!data || !data.displayName) return;
    log('ユーザー参加:', data.displayName);
    const msg = `${data.displayName}さんが参加しました`;
    queueNotification(msg, 'info');
    appendToFeed(msg, '#a5d6a7', '参加');
  }

  function onUserLeave(data) {
    if (!data || !data.displayName) return;
    log('ユーザー離脱:', data.displayName);
    const msg = `${data.displayName}さんが離脱しました`;
    queueNotification(msg, 'info');
    appendToFeed(msg, '#ef9a9a', '離脱');
    // Phase 4: リモート選択をクリア
    if (data.socketId) clearRemoteSelection(data.socketId);
  }

  // Phase 3: 競合検出通知
  function onConflictDetected(data) {
    if (!data) return;
    log('競合検出:', data.taskId, 'vs', data.conflictUser);
    showToast(`⚠️ ${data.conflictUser}さんが同時に編集しました（最新の操作で上書きされます）`, 'warning', 5000);
  }

  // Phase 3/4: 他ユーザーのタスクロック通知（マスク表示付き）
  function onTaskLocked(data) {
    if (!data || !data.taskId) return;
    log('タスクロック:', data.taskId, 'by', data.lockedBy);
    // ガントチャート本体にロック状態を通知
    document.dispatchEvent(new CustomEvent('collab:taskLocked', { detail: data }));
    // Phase 4: ロックマスク表示
    _activeLockOverlays[data.taskId] = { color: data.color || '#888', lockedBy: data.lockedBy };
    showLockOverlay(data.taskId, data.color || '#888', data.lockedBy);
  }

  function onTaskUnlocked(data) {
    if (!data || !data.taskId) return;
    log('タスクロック解除:', data.taskId);
    document.dispatchEvent(new CustomEvent('collab:taskUnlocked', { detail: data }));
    // Phase 4: ロックマスク削除
    delete _activeLockOverlays[data.taskId];
    removeLockOverlay(data.taskId);
  }

  // Phase 4-B: 依存線ロック通知
  function onDepLocked(data) {
    if (!data || !data.depId) return;
    log('依存線ロック:', data.depId, 'by', data.lockedBy);
    _activeDepLockOverlays[data.depId] = { color: data.color || '#888', lockedBy: data.lockedBy };
    showDepLockOverlay(data.depId, data.color || '#888', data.lockedBy);
  }
  function onDepUnlocked(data) {
    if (!data || !data.depId) return;
    log('依存線ロック解除:', data.depId);
    delete _activeDepLockOverlays[data.depId];
    removeDepLockOverlay(data.depId);
  }
  // Phase 4-C: 注記ロック通知
  function onAnnLocked(data) {
    if (!data || !data.annId) return;
    log('注記ロック:', data.annId, 'by', data.lockedBy);
    _activeAnnLockOverlays[data.annId] = { color: data.color || '#888', lockedBy: data.lockedBy };
    showAnnLockOverlay(data.annId, data.color || '#888', data.lockedBy);
  }
  function onAnnUnlocked(data) {
    if (!data || !data.annId) return;
    log('注記ロック解除:', data.annId);
    delete _activeAnnLockOverlays[data.annId];
    removeAnnLockOverlay(data.annId);
  }

  // ════════════════════════════════════════════════════════════
  // Phase 4: 協調UI — 選択ハイライト・ロックマスク・変更フィード
  // ════════════════════════════════════════════════════════════

  // ── 他ユーザーの選択表示 ──────────────────────────────
  // remoteSelections: { socketId → { taskIds, color, displayName, ts } }
  const remoteSelections = new Map();
  let _selectionSyncTimer = null;
  let _activeLockOverlays = {}; // Phase 4: taskId → { color, lockedBy }（ロックマスク再適用用）
  let _activeDepLockOverlays = {}; // Phase 4-B: depId → { color, lockedBy }
  let _activeAnnLockOverlays = {}; // Phase 4-C: annId → { color, lockedBy }

  function onRemoteSelect(data) {
    if (!data || !data.socketId) return;
    // 自分の選択は無視
    if (data.socketId === (socket && socket.id)) return;
    remoteSelections.set(data.socketId, {
      taskIds: data.taskIds || [],
      dependencyIds: data.dependencyIds || [],
      annotationIds: data.annotationIds || [],
      color: data.color || '#888',
      displayName: data.displayName || '他のユーザー',
      ts: data.ts || Date.now(),
    });
    renderRemoteSelections();
  }

  function renderRemoteSelections() {
    // 既存のリモート選択マークを削除（タスク＋依存線）
    document.querySelectorAll('.collab-remote-selection').forEach(el => el.remove());
    document.querySelectorAll('.collab-remote-dep-selection').forEach(el => el.remove());
    document.querySelectorAll('.collab-remote-ann-selection').forEach(el => el.remove());

    var svgNS = 'http://www.w3.org/2000/svg';
    var depLayer = document.getElementById('dependencyLayer');
    var barsLayer = document.getElementById('barsLayer');

    remoteSelections.forEach((info) => {
      var color = info.color || '#888';
      var dname = info.displayName || '他のユーザー';

      // ── タスクバーの選択ハイライト＋バッジ ──
      (info.taskIds || []).forEach(taskId => {
        const bar = document.querySelector(`.task-bar[data-task-id="${taskId}"]`);
        if (!bar) return;
        const parent = bar.parentElement;
        if (!parent) return;
        // 枠線オーバーレイ
        const overlay = document.createElement('div');
        overlay.className = 'collab-remote-selection';
        overlay.style.cssText = `position:absolute;left:${bar.offsetLeft - 2}px;top:${bar.offsetTop - 2}px;width:${bar.offsetWidth + 4}px;height:${bar.offsetHeight + 4}px;border:2px solid ${color};border-radius:5px;pointer-events:none;box-sizing:border-box;z-index:10;opacity:0.8;`;
        overlay.title = `${dname}さんが選択中`;
        parent.appendChild(overlay);
        // 選択バッジ（表示名）— barsLayer に直接配置し、top を clamp して日付ヘッダーに隠れないようにする
        const badge = document.createElement('div');
        badge.className = 'collab-remote-selection';
        try {
          const overlayRect = overlay.getBoundingClientRect();
          const barsRect3 = barsLayer ? barsLayer.getBoundingClientRect() : null;
          if (barsRect3 && overlayRect.width > 0) {
            const badgeMidX = overlayRect.left + overlayRect.width / 2 - barsRect3.left;
            const badgeRawTop = overlayRect.top - barsRect3.top - 4;
            const badgeTop = Math.max(2, badgeRawTop); // 最上段タスクで日付ヘッダーに隠れないよう clamp
            badge.style.cssText = `position:absolute;left:${badgeMidX}px;top:${badgeTop}px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:${color};color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:11;`;
            badge.textContent = `👆 ${dname}`;
            barsLayer.appendChild(badge);
          }
        } catch(e3) { /* getBoundingClientRect 例外時はスキップ */ }
      });

      // ── 依存線（矢印線）の選択ハイライト＋バッジ ──
      (info.dependencyIds || []).forEach(depId => {
        const depPath = document.querySelector(`.dependency-path[data-dependency-id="${depId}"]`);
        if (!depPath) return;
        if (!depLayer) return;

        // SVGオーバーレイパス（色付き太線）
        const overlayPath = document.createElementNS(svgNS, 'path');
        overlayPath.setAttribute('class', 'collab-remote-dep-selection');
        overlayPath.setAttribute('d', depPath.getAttribute('d'));
        overlayPath.setAttribute('fill', 'none');
        overlayPath.setAttribute('stroke', color);
        overlayPath.setAttribute('stroke-width', '4');
        overlayPath.setAttribute('stroke-linecap', 'round');
        overlayPath.setAttribute('stroke-linejoin', 'round');
        overlayPath.setAttribute('opacity', '0.5');
        overlayPath.setAttribute('pointer-events', 'none');
        depLayer.appendChild(overlayPath);

        // バッジ（表示名）— 依存線の中間点付近に配置
        try {
          const depRect = depPath.getBoundingClientRect();
          const barsRect = barsLayer ? barsLayer.getBoundingClientRect() : null;
          if (barsRect && depRect.width > 0) {
            const midX = depRect.left + depRect.width / 2 - barsRect.left;
            const midY = depRect.top + depRect.height / 2 - barsRect.top;
            const depBadgeTop = Math.max(2, midY - 12); // 最上段で日付ヘッダーに隠れないよう clamp
            const badge = document.createElement('div');
            badge.className = 'collab-remote-dep-selection';
            badge.style.cssText = `position:absolute;left:${midX}px;top:${depBadgeTop}px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:${color};color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:11;`;
            badge.textContent = `👆 ${dname}`;
            barsLayer.appendChild(badge);
          }
        } catch(e) { /* getBoundingClientRect 例外時はスキップ */ }
      });

      // ── アノテーションの選択ハイライト＋バッジ ──
      (info.annotationIds || []).forEach(annId => {
        var annG = document.querySelector('#annotationLayer g[data-ann-id="' + annId + '"]');
        if (!annG) return;

        // SVGオーバーレイ rect（色付き枠線）
        try {
          var bbox = annG.getBBox();
          if (bbox && bbox.width > 0) {
            var overlayRect = document.createElementNS(svgNS, 'rect');
            overlayRect.setAttribute('class', 'collab-remote-ann-selection');
            overlayRect.setAttribute('x', String(bbox.x - 3));
            overlayRect.setAttribute('y', String(bbox.y - 3));
            overlayRect.setAttribute('width', String(bbox.width + 6));
            overlayRect.setAttribute('height', String(bbox.height + 6));
            overlayRect.setAttribute('fill', 'none');
            overlayRect.setAttribute('stroke', color);
            overlayRect.setAttribute('stroke-width', '3');
            overlayRect.setAttribute('stroke-dasharray', '6 3');
            overlayRect.setAttribute('rx', '6');
            overlayRect.setAttribute('opacity', '0.7');
            overlayRect.setAttribute('pointer-events', 'none');
            if (depLayer) depLayer.appendChild(overlayRect);

            // バッジ（表示名）— アノテーションの上中央に配置
            if (barsLayer) {
              var barsRect2 = barsLayer.getBoundingClientRect();
              // annotationLayer と barsLayer は同じ timelineCanvas 内に同じ座標系
              var annRect2 = annG.getBoundingClientRect();
              if (annRect2.width > 0) {
                var midX2 = annRect2.left + annRect2.width / 2 - barsRect2.left;
                var topY2 = Math.max(2, annRect2.top - barsRect2.top - 20); // 最上段で日付ヘッダーに隠れないよう clamp
                var annBadge = document.createElement('div');
                annBadge.className = 'collab-remote-ann-selection';
                annBadge.style.cssText = 'position:absolute;left:' + midX2 + 'px;top:' + topY2 + 'px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:' + color + ';color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:11;';
                annBadge.textContent = '👆 ' + dname;
                barsLayer.appendChild(annBadge);
              }
            }
          }
        } catch(e2) { /* getBBox 例外時はスキップ */ }
      });
    });
  }

  // タスク選択変更時にサーバーへ通知
  function syncSelectionToServer(taskIds, dependencyIds, annotationIds) {
    if (!connected || !socket) return;
    // デバウンス: 100ms以内の連続選択変更をまとめる
    if (_selectionSyncTimer) clearTimeout(_selectionSyncTimer);
    _selectionSyncTimer = setTimeout(() => {
      socket.emit('task_select', {
        projectId: CONFIG.PROJECT_ID,
        taskIds: taskIds,
        dependencyIds: dependencyIds || [],
        annotationIds: annotationIds || [],
      });
    }, 100);
  }

  // user_leave時にリモート選択をクリア
  function clearRemoteSelection(socketId) {
    if (remoteSelections.has(socketId)) {
      remoteSelections.delete(socketId);
      renderRemoteSelections();
    }
  }

  // ── 編集ロックマスク表示 ──────────────────────────────
  function showLockOverlay(taskId, color, lockedBy) {
    removeLockOverlay(taskId);
    const bar = document.querySelector(`.task-bar[data-task-id="${taskId}"]`);
    if (!bar) return;
    const parent = bar.parentElement;
    if (!parent) return;
    // 親要素(barsLayer)基準でオーバーレイを配置
    // マスク本体（半透明）
    const overlay = document.createElement('div');
    overlay.className = 'collab-lock-overlay';
    overlay.dataset.taskId = taskId;
    overlay.style.cssText = `position:absolute;left:${bar.offsetLeft}px;top:${bar.offsetTop}px;width:${bar.offsetWidth}px;height:${bar.offsetHeight}px;background:${color};opacity:0.3;border-radius:4px;pointer-events:none;box-sizing:border-box;z-index:10;`;
    parent.appendChild(overlay);
    // ラベル(🔒表示名)はマスクの子にせず兄弟要素として配置（opacity継承を回避）
    const label = document.createElement('div');
    label.className = 'collab-lock-overlay';
    label.dataset.taskId = taskId;
    label.dataset.lockLabel = '1';
    label.style.cssText = `position:absolute;left:${bar.offsetLeft + bar.offsetWidth / 2}px;top:${Math.max(2, bar.offsetTop - 4)}px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:${color};color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:12;opacity:1;`;
    label.textContent = `🔒 ${lockedBy}`;
    parent.appendChild(label);
  }

  function removeLockOverlay(taskId) {
    document.querySelectorAll(`.collab-lock-overlay[data-task-id="${taskId}"]`).forEach(el => el.remove());
  }

  // Phase 4-B: 依存線ロックマスク
  function showDepLockOverlay(depId, color, lockedBy) {
    removeDepLockOverlay(depId);
    const depPath = document.querySelector(`.dependency-path[data-dependency-id="${depId}"]`);
    if (!depPath) return;
    const depLayer = document.getElementById('dependencyLayer');
    if (!depLayer) return;
    try {
      const bbox = depPath.getBBox();
      const svgNS = 'http://www.w3.org/2000/svg';
      const overlay = document.createElementNS(svgNS, 'rect');
      overlay.setAttribute('class', 'collab-dep-lock-overlay');
      overlay.setAttribute('data-dep-id', depId);
      overlay.setAttribute('x', String(bbox.x - 3));
      overlay.setAttribute('y', String(bbox.y - 3));
      overlay.setAttribute('width', String(bbox.width + 6));
      overlay.setAttribute('height', String(bbox.height + 6));
      overlay.setAttribute('fill', 'none');
      overlay.setAttribute('stroke', color);
      overlay.setAttribute('stroke-width', '4');
      overlay.setAttribute('stroke-dasharray', '6 3');
      overlay.setAttribute('rx', '4');
      overlay.setAttribute('opacity', '0.5');
      overlay.setAttribute('pointer-events', 'none');
      depLayer.appendChild(overlay);
      // ラベル
      const barsLayer = document.getElementById('barsLayer');
      if (barsLayer) {
        const depRect = depPath.getBoundingClientRect();
        const barsRect = barsLayer.getBoundingClientRect();
        if (depRect.width > 0) {
          const midX = depRect.left + depRect.width / 2 - barsRect.left;
          const midY = depRect.top + depRect.height / 2 - barsRect.top;
          const label = document.createElement('div');
          label.className = 'collab-dep-lock-overlay';
          label.dataset.depId = depId;
          const labelTop = Math.max(2, midY - 12);
          label.style.cssText = `position:absolute;left:${midX}px;top:${labelTop}px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:${color};color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:12;opacity:1;`;
          label.textContent = `🔒 ${lockedBy}`;
          barsLayer.appendChild(label);
        }
      }
    } catch(e) { /* getBBox 例外時スキップ */ }
  }
  function removeDepLockOverlay(depId) {
    document.querySelectorAll(`.collab-dep-lock-overlay[data-dep-id="${depId}"]`).forEach(el => el.remove());
  }

  // Phase 4-C: 注記ロックマスク
  function showAnnLockOverlay(annId, color, lockedBy) {
    removeAnnLockOverlay(annId);
    const annG = document.querySelector(`#annotationLayer g[data-ann-id="${annId}"]`);
    if (!annG) return;
    const depLayer = document.getElementById('dependencyLayer');
    const barsLayer = document.getElementById('barsLayer');
    try {
      const bbox = annG.getBBox();
      if (bbox && bbox.width > 0) {
        const svgNS = 'http://www.w3.org/2000/svg';
        const overlay = document.createElementNS(svgNS, 'rect');
        overlay.setAttribute('class', 'collab-ann-lock-overlay');
        overlay.setAttribute('data-ann-id', annId);
        overlay.setAttribute('x', String(bbox.x - 4));
        overlay.setAttribute('y', String(bbox.y - 4));
        overlay.setAttribute('width', String(bbox.width + 8));
        overlay.setAttribute('height', String(bbox.height + 8));
        overlay.setAttribute('fill', 'none');
        overlay.setAttribute('stroke', color);
        overlay.setAttribute('stroke-width', '3');
        overlay.setAttribute('stroke-dasharray', '6 3');
        overlay.setAttribute('rx', '6');
        overlay.setAttribute('opacity', '0.7');
        overlay.setAttribute('pointer-events', 'none');
        if (depLayer) depLayer.appendChild(overlay);
        // ラベル
        if (barsLayer) {
          const barsRect = barsLayer.getBoundingClientRect();
          const annRect = annG.getBoundingClientRect();
          if (annRect.width > 0) {
            const midX = annRect.left + annRect.width / 2 - barsRect.left;
            const rawTop = annRect.top - barsRect.top - 20;
            const labelTop = Math.max(2, rawTop);
            const label = document.createElement('div');
            label.className = 'collab-ann-lock-overlay';
            label.dataset.annId = annId;
            label.style.cssText = `position:absolute;left:${midX}px;top:${labelTop}px;transform:translateX(-50%);font-size:10px;white-space:nowrap;background:${color};color:#fff;padding:1px 6px;border-radius:3px;pointer-events:none;z-index:12;opacity:1;`;
            label.textContent = `🔒 ${lockedBy}`;
            barsLayer.appendChild(label);
          }
        }
      }
    } catch(e) { /* getBBox 例外時スキップ */ }
  }
  function removeAnnLockOverlay(annId) {
    document.querySelectorAll(`.collab-ann-lock-overlay[data-ann-id="${annId}"]`).forEach(el => el.remove());
  }

  // onTaskLockedを強化（マスク表示追加）
  function onTaskLockedEnhanced(data) {
    if (!data || !data.taskId) return;
    log('タスクロック:', data.taskId, 'by', data.lockedBy);
    document.dispatchEvent(new CustomEvent('collab:taskLocked', { detail: data }));
    // Phase 4: ロックマスク表示
    showLockOverlay(data.taskId, data.color || '#888', data.lockedBy);
  }

  // Phase 3: 編集ロック要求（ドラッグ開始時に呼ぶ）
  // 注意: socket.emitのコールバックは非同期だが、ドラッグ開始は同期的に判定する必要があるため、
  // 一旦trueを返してドラッグを許可し、ロック取得失敗時はイベントでキャンセル通知する方式。
  let _currentLockedTaskId = null; // Phase 4-A: 現在ロック中のtaskId（EC-6: 古いロック解放用）
  function requestTaskLock(taskId, onResult) {
    if (!connected || !socket) { if (onResult) onResult(true, null); return true; }
    // EC-6: 既に別のtaskIdをロック中なら先に解放
    if (_currentLockedTaskId && _currentLockedTaskId !== taskId) {
      releaseTaskLock(_currentLockedTaskId);
    }
    _currentLockedTaskId = taskId;
    socket.emit('task_lock', {
      projectId: CONFIG.PROJECT_ID,
      taskId: taskId,
    }, (res) => {
      if (res && res.locked) {
        showToast(`🔒 ${res.lockedBy}さんが編集中です`, 'warning', 3000);
        document.dispatchEvent(new CustomEvent('collab:dragCancel', {
          detail: { taskId: taskId, lockedBy: res.lockedBy }
        }));
        _currentLockedTaskId = null;
        if (onResult) onResult(false, res.lockedBy);
      } else {
        if (onResult) onResult(true, null);
      }
    });
    return true;
  }

  // Phase 3: 編集ロック解放（ドラッグ終了時に呼ぶ）
  function releaseTaskLock(taskId) {
    if (!connected || !socket) return;
    if (_currentLockedTaskId === taskId) _currentLockedTaskId = null;
    socket.emit('task_unlock', {
      projectId: CONFIG.PROJECT_ID,
      taskId: taskId,
    });
  }

  // Phase 4-A: 複数タスク一括ロック（forEach内で旧ロック解放をスキップ）
  let _currentLockedTaskIds = new Set(); // 複数ロック追跡用
  function requestTaskLockMulti(taskIds) {
    if (!connected || !socket) return;
    // 単一の_currentLockedTaskIdがあれば先に解放
    if (_currentLockedTaskId) {
      releaseTaskLock(_currentLockedTaskId);
      _currentLockedTaskId = null;
    }
    _currentLockedTaskIds = new Set();
    taskIds.forEach(function(tid) {
      _currentLockedTaskIds.add(tid);
      socket.emit('task_lock', {
        projectId: CONFIG.PROJECT_ID,
        taskId: tid,
      }, (res) => {
        if (res && res.locked) {
          showToast(`🔒 ${res.lockedBy}さんが編集中です`, 'warning', 3000);
          _currentLockedTaskIds.delete(tid);
        }
      });
    });
  }
  function releaseTaskLockMulti(taskIds) {
    if (!connected || !socket) return;
    taskIds.forEach(function(tid) {
      _currentLockedTaskIds.delete(tid);
      socket.emit('task_unlock', {
        projectId: CONFIG.PROJECT_ID,
        taskId: tid,
      });
    });
  }

  // Phase 4-B: 依存線ロック要求・解放
  function requestDepLock(depId, onResult) {
    if (!connected || !socket) { if (onResult) onResult(true, null); return; }
    socket.emit('dep_lock', { projectId: CONFIG.PROJECT_ID, depId: depId }, (res) => {
      if (res && res.locked) {
        showToast(`🔒 ${res.lockedBy}さんが編集中です`, 'warning', 3000);
        if (onResult) onResult(false, res.lockedBy);
      } else {
        if (onResult) onResult(true, null);
      }
    });
  }
  function releaseDepLock(depId) {
    if (!connected || !socket) return;
    socket.emit('dep_unlock', { projectId: CONFIG.PROJECT_ID, depId: depId });
  }

  // Phase 4-C: 注記ロック要求・解放
  function requestAnnLock(annId, onResult) {
    if (!connected || !socket) { if (onResult) onResult(true, null); return; }
    socket.emit('ann_lock', { projectId: CONFIG.PROJECT_ID, annId: annId }, (res) => {
      if (res && res.locked) {
        showToast(`🔒 ${res.lockedBy}さんが編集中です`, 'warning', 3000);
        if (onResult) onResult(false, res.lockedBy);
      } else {
        if (onResult) onResult(true, null);
      }
    });
  }
  function releaseAnnLock(annId) {
    if (!connected || !socket) return;
    socket.emit('ann_unlock', { projectId: CONFIG.PROJECT_ID, annId: annId });
  }

  function onFullSync(data) {
    log('フル同期受信 v', data.version);
    if (data.snapshot) {
      applyRemoteSnapshot(data.snapshot, data.version);
      showToast('🔄 最新情報に同期しました', 'info');
    }
  }

  // 新規参加者でスナップショットがない時、サーバーから送信依頼を受けた場合
  function onSnapshotRequest(data) {
    log('スナップショット送信依頼受信 requester:', data && data.requesterId);
    // 即時スナップショットを送信（デバウンスなしで即時送信）
    if (!connected || !socket) return;
    const bridge = window.__ganttBridge;
    if (!bridge || !bridge.getSnapshot) return;
    try {
      const snapshot = bridge.getSnapshot();
      socket.emit('snapshot_update', {
        projectId: CONFIG.PROJECT_ID,
        snapshot,
        version:   serverVersion,
      }, (res) => {
        if (res && res.ok) log('スナップショット送信(依頼応答)完了 v', res.version);
      });
    } catch (err) {
      warn('onSnapshotRequest getSnapshot 失敗:', err);
    }
  }

  function applyRemoteOp(serverOp) {
    const bridge = window.__ganttBridge;
    if (!bridge || !bridge.applyRemoteOp) {
      warn('__ganttBridge が未準備です。操作をスキップ:', serverOp.type);
      return;
    }
    try {
      bridge.applyRemoteOp(serverOp);
    } catch (err) {
      warn('applyRemoteOp 失敗:', err, serverOp);
    }
  }

  function applyRemoteSnapshot(snapshot, version) {
    const bridge = window.__ganttBridge;
    if (!bridge || !bridge.loadFromData) {
      warn('__ganttBridge.loadFromData が未準備です');
      return;
    }
    // デバッグ: snapshotの構造をログ出力
    log('applyRemoteSnapshot 開始 v' + version +
      ' project=' + (snapshot && snapshot.project ? snapshot.project.name || 'OK' : 'MISSING') +
      ' rows=' + (snapshot && Array.isArray(snapshot.rows) ? snapshot.rows.length : 'MISSING') +
      ' tasks=' + (snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks.length : 'MISSING')
    );
    if (!snapshot || !snapshot.project || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.tasks)) {
      warn('applyRemoteSnapshot: snapshot構造不正、適用をスキップします', JSON.stringify(snapshot).slice(0,200));
      return;
    }
    try {
      bridge.loadFromData(snapshot);
      serverVersion = version;
      log('スナップショット適用完了 v', version);
    } catch (err) {
      warn('loadFromData 失敗:', err);
    }
  }

  /* ================================================================
     7. スナップショット送信 (デバウンス)
  ================================================================ */

  const _sendSnapshotNow = debounce(function () {
    if (!connected || !socket) return;
    const bridge = window.__ganttBridge;
    if (!bridge || !bridge.getSnapshot) return;
    try {
      const snapshot = bridge.getSnapshot();
      socket.emit('snapshot_update', {
        projectId: CONFIG.PROJECT_ID,
        snapshot,
        version:   serverVersion,
      }, (res) => {
        if (res && res.ok) log('スナップショット送信完了 v', res.version);
      });
    } catch (err) {
      warn('getSnapshot 失敗:', err);
    }
  }, CONFIG.SNAPSHOT_DEBOUNCE);

  function sendSnapshot() {
    _sendSnapshotNow();
  }

  /* ================================================================
     8. gantt:op イベントのリッスン
  ================================================================ */

  document.addEventListener('gantt:op', function (e) {
    const detail = e.detail;
    if (!detail || !detail.op) return;
    if (window.__ganttIsRemoteApplying) return;
    sendOp(detail.op, detail);
    if (detail.op === 'task_edit') {
      void handleTaskAssignNotification(detail);
      // Phase 5-4: @メンション通知
      if (detail.mentionedUserIds && detail.mentionedUserIds.length > 0) {
        console.log('[Mention] gantt:op task_edit でメンション検出:', detail.mentionedUserIds);
        void handleMentionNotification(detail);
      } else {
        // mentionedUserIds が null/空の場合のデバッグ
        if (detail.mentionedUserIds !== undefined) {
          console.log('[Mention] mentionedUserIds あり・空:', detail.mentionedUserIds);
        }
      }
    }
  });

  async function handleTaskAssignNotification(detail) {
    if (!authUser || !CONFIG.PROJECT_ID) return;
    if (detail.assigneeUserId === undefined && detail.prevAssigneeUserId === undefined) return;

    // 複数担当対応: assigneeUserId は配列または単一値
    const toArray = (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.map(Number).filter(Boolean);
      const n = Number(v);
      return n ? [n] : [];
    };
    const nextIds = toArray(detail.assigneeUserId);
    const prevIds = toArray(detail.prevAssigneeUserId);

    // 変更があるかチェック（配列の差分）
    const myId = Number(authUser.id || 0);
    const added   = nextIds.filter(id => !prevIds.includes(id));
    const removed = prevIds.filter(id => !nextIds.includes(id));
    if (added.length === 0 && removed.length === 0) return;

    // 自分が自分を担当に設定した場合は自分への通知をスキップするためのフラグ
    // PHP 側でも同様にスキップするが、JS 側でペイロードに送る
    // (PHP 側の actor_user_id と照合して除外する)

    try {
      const res = await fetch('/WebGantt/api/notifications.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_assign',
          project_id: CONFIG.PROJECT_ID,
          task_id: detail.taskId || '',
          task_name: detail.name || 'タスク',
          assignee_user_ids: added,       // 新規追加された担当者のuserId配列
          prev_assignee_user_ids: removed, // 削除された担当者のuserId配列
          // 後方互換: 単一値も送る
          assignee_user_id: added.length > 0 ? added[0] : null,
          prev_assignee_user_id: removed.length > 0 ? removed[0] : null,
        }),
      });
      if (!res.ok) throw new Error(`create_assign http ${res.status}`);
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.created_notifications)) {
        const myUserId = Number(authUser.id || 0) || null;
        if (myUserId && data.created_notifications.some((item) => Number(item.user_id || 0) === myUserId)) {
          if (window.__notificationModule && typeof window.__notificationModule.reload === 'function') {
            window.__notificationModule.reload();
          }
        }
      }
    } catch (err) {
      console.warn('[Notification] create_assign failed', err);
    }
  }

  /* ================================================================
     Phase 5-4: @メンション通知送信
  ================================================================ */
  async function handleMentionNotification(detail) {
    console.log('[Mention] handleMentionNotification 呼び出し', {
      authUser: !!authUser,
      projectId: CONFIG.PROJECT_ID,
      mentionedUserIds: detail.mentionedUserIds,
    });
    if (!authUser || !CONFIG.PROJECT_ID) {
      console.warn('[Mention] authUser or PROJECT_ID が未設定のためスキップ');
      return;
    }
    const mentionedUserIds = Array.isArray(detail.mentionedUserIds)
      ? detail.mentionedUserIds.filter(id => Number(id) > 0)
      : [];
    if (mentionedUserIds.length === 0) {
      console.warn('[Mention] mentionedUserIds が空のためスキップ');
      return;
    }

    const actorId  = Number(authUser.id || 0);
    const taskId   = String(detail.taskId || '');
    const taskName = String(detail.name   || 'タスク');
    const projId   = CONFIG.PROJECT_ID;
    // メモ優先、なければ内容(content)を通知メッセージとして使用
    const memoText    = String(detail.memo    || '').trim();
    const contentText = String(detail.content || '').trim();
    const mentionMessage = memoText || contentText || '';

    console.log('[Mention] create_mention POST 送信', { projId, taskId, taskName, mentionedUserIds, actorId });

    try {
      const res = await fetch('/WebGantt/api/notifications.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:              'create_mention',
          project_id:          projId,
          task_id:             taskId,
          task_name:           taskName,
          mentioned_user_ids:  mentionedUserIds,
          from_user_id:        actorId,
          mention_message:     mentionMessage,  // メモ or 内容テキスト
        }),
      });
      if (!res.ok) throw new Error(`create_mention http ${res.status}`);
      const data = await res.json();
      console.log('[Mention] create_mention レスポンス', data);
      if (data && data.ok) {
        // 通知を受け取ったユーザーに自分が含まれるかに関わらず常にリロード
        if (window.__notificationModule && typeof window.__notificationModule.reload === 'function') {
          window.__notificationModule.reload();
        }
      }
    } catch (err) {
      console.warn('[Mention] create_mention failed', err);
    }
  }

  document.addEventListener('gantt:remoteLoad', function () {
    sendSnapshot();
  });

  /* ================================================================
     9. プレゼンス UI
  ================================================================ */

  function onPresenceUpdate(data) {
    UI.renderPresence(data.users || []);
  }

  /* ================================================================
     10. UI コンポーネント
  ================================================================ */

  const UI = (function () {
    let statusBar  = null;
    let presenceEl = null;
    let userEl     = null;  // Phase 2-A: ユーザー名表示
    let logoutBtn  = null;  // Phase 2-A: ログアウトボタン
    let myColor    = '#1E88E5';
    // [Mobile] init()内で判定した値をrenderPresence()等の他の関数からも
    // 参照できるよう、IIFEのトップレベル変数として保持する（init()内の
    // ローカル変数 _isMobilePage とは別名にして、既存のinit()内ロジックは
    // 一切変更しない）。
    let _isMobilePageTop = false;
    // [Mobile] 「接続者」一覧メニュー（#collab-presence-menu）関連。
    // PC版には存在しないモバイル専用コンポーネントで、renderPresence()から
    // 最新の接続者リストを保持・メニュー内容の再構築を行うために使う。
    let _presenceUsers = [];
    let _refreshPresenceMenuIfOpen = null;

    // 背景色に対して最も視認性の高い文字色を返すヘルパー（WCAG相対輝度）
    function calcTextColor(hex) {
      const c = (hex || '#555555').replace('#', '');
      if (c.length !== 6) return '#ffffff';
      const r = parseInt(c.substring(0,2),16) / 255;
      const g = parseInt(c.substring(2,4),16) / 255;
      const b = parseInt(c.substring(4,6),16) / 255;
      const toLin = v => v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
      const L = 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
      return L > 0.179 ? '#1a1a1a' : '#ffffff';
    }

    function init() {
      // [Mobile] gantt-mobile.html では下部ステータスバーの機能は
      // 統合メニューに集約するため、通常のレイアウト調整は行わず、
      // ステータスバー自体は非表示にする（要素は残し、機能は再利用する）。
      const _isMobilePage = Boolean(window.__GANTT_MOBILE__);
      // IIFEトップレベルの変数(_isMobilePage)にも反映し、renderPresence()等の
      // 他の関数から参照できるようにする（このローカル変数自体は以下、init()内
      // で従来通り使用を継続する。ロジック変更はない）。
      _isMobilePageTop = _isMobilePage;

      if (!_isMobilePage) {
        const adjustStyle = document.createElement('style');
        adjustStyle.id = 'collab-layout-adjust';
        adjustStyle.textContent = [
          '.app-shell { height: calc(100vh - 24px) !important; }',
          '#statusToastRegion { bottom: 30px !important; }',
        ].join('\n');
        document.head.appendChild(adjustStyle);
      }

      statusBar = document.createElement('div');
      statusBar.id = 'collab-status-bar';
      Object.assign(statusBar.style, {
        position:       'fixed',
        bottom:         '0',
        left:           '0',
        right:          '0',
        height:         '24px',
        background:     '#2d2d2d',
        color:          '#ccc',
        fontSize:       '11px',
        display:        'flex',
        alignItems:     'center',
        padding:        '0 12px',
        zIndex:         '99999',
        gap:            '12px',
        userSelect:     'none',
        fontFamily:     'monospace',
      });

      // collab-dot は label の絵文字と重複するため非表示（DOM上は残してsetStatusが参照できるようにする）
      const dot = document.createElement('span');
      dot.id = 'collab-dot';
      dot.textContent = '';
      dot.style.display = 'none';

      const label = document.createElement('span');
      label.id = 'collab-label';
      label.textContent = '接続中…';

      // Phase 2-A: ユーザー名表示（👤アイコンなし・背景色を個人カラーと連動）
      userEl = document.createElement('span');
      userEl.id = 'collab-user';
      let _userDisplayName = authUser ? authUser.displayName + (authUser.role === 'admin' ? ' (管理者)' : '') : 'ゲスト';
      userEl.textContent = _userDisplayName;
      Object.assign(userEl.style, {
        display:         'inline-flex',
        alignItems:      'center',
        height:          '17px',
        padding:         '0 7px',
        fontSize:        '11px',
        borderRadius:    '4px',
        background:      '#555',      // 初期色（接続前）
        color:           '#fff',
        lineHeight:      '1',
        fontWeight:      '600',
        letterSpacing:   '0.02em',
      });

      // ボタン共通スタイル適用ヘルパー
      function applyBtnStyle(el, colorText, colorBorder) {
        Object.assign(el.style, {
          display:         'inline-flex',
          alignItems:      'center',
          height:          '17px',
          padding:         '0 7px',
          fontSize:        '11px',
          color:           colorText,
          background:      'rgba(255,255,255,0.07)',
          border:          '1px solid ' + colorBorder,
          borderRadius:    '4px',
          textDecoration:  'none',
          cursor:          'pointer',
          lineHeight:      '1',
          transition:      'background 0.15s',
        });
        el.onmouseenter = function () { el.style.background = 'rgba(255,255,255,0.15)'; };
        el.onmouseleave = function () { el.style.background = 'rgba(255,255,255,0.07)'; };
      }

      // Phase 2-B: プロジェクト管理ボタン
      var projectBtn = document.createElement('a');
      projectBtn.id = 'collab-project-btn';
      projectBtn.textContent = 'プロジェクト管理';
      projectBtn.href = '#';
      applyBtnStyle(projectBtn, '#90caf9', 'rgba(144,202,249,0.45)');
      projectBtn.onclick = function (e) {
        e.preventDefault();
        // 現在のプロジェクトIDを記憶（戻る時に復元するため）
        try { sessionStorage.setItem('gantt_last_project', CONFIG.PROJECT_ID); } catch (err) {}
        // WebSocket切断はbeforeunloadで処理（キャンセルされた場合は再接続）
        _navigatingTo = '/WebGantt/projects.html';
        _navigationAttempted = true;
        window.location.href = '/WebGantt/projects.html';
      };

      // Phase 2-A: アカウント管理ボタン
      var accountBtn = document.createElement('a');
      accountBtn.id = 'collab-account-btn';
      accountBtn.textContent = 'アカウント管理';
      accountBtn.href = '#';
      applyBtnStyle(accountBtn, '#90caf9', 'rgba(144,202,249,0.45)');
      accountBtn.onclick = function (e) {
        e.preventDefault();
        // 現在のプロジェクトIDを記憶（戻る時に復元するため）
        try { sessionStorage.setItem('gantt_last_project', CONFIG.PROJECT_ID); } catch (err) {}
        // WebSocket切断はbeforeunloadで処理（キャンセルされた場合は再接続）
        _navigatingTo = '/WebGantt/account.html';
        _navigationAttempted = true;
        window.location.href = '/WebGantt/account.html';
      };

      // Phase 2-A: ログアウトボタン
      logoutBtn = document.createElement('a');
      logoutBtn.id = 'collab-logout-btn';
      logoutBtn.textContent = 'ログアウト';
      logoutBtn.href = '#';
      applyBtnStyle(logoutBtn, '#ef9a9a', 'rgba(239,154,154,0.40)');
      logoutBtn.onclick = function (e) {
        e.preventDefault();
        // ログイン画面の ?logout=1 でログアウト処理を実行する
        // WebSocket切断はbeforeunloadで処理（キャンセル時は再接続）
        _navigatingTo = CONFIG.LOGIN_URL + '?logout=1';
        _navigationAttempted = true;
        _isLogoutNavigation = true;
        window.location.href = CONFIG.LOGIN_URL + '?logout=1';
      };

      presenceEl = document.createElement('span');
      presenceEl.id = 'collab-presence';
      presenceEl.style.marginLeft = 'auto';

      // ─── プロジェクト切替ボタン ＆ ドロップアップメニュー ───────────────
      const switchBtn = document.createElement('a');
      switchBtn.id   = 'collab-switch-btn';
      switchBtn.href = '#';
      switchBtn.textContent = 'プロジェクト切替 ▾';
      applyBtnStyle(switchBtn, '#a5d6a7', 'rgba(165,214,167,0.45)');

      // [Mobile] モバイル版では下部ステータスバー自体が非表示のため、
      // switchBtn.getBoundingClientRect() が画面左下端相当の値になり、
      // メニューがそこに貼り付いて表示されてしまう不具合があった。
      // 通知パネル(#notif-panel)と同じ「画面中央固定表示＋背景オーバーレイ」に統一する。
      // PC版（_isMobilePage=false）は既存のドロップアップ表示を変更しない。
      let switchOverlay = null;
      if (_isMobilePage) {
        switchOverlay = document.createElement('div');
        switchOverlay.id = 'collab-switch-overlay';
        Object.assign(switchOverlay.style, {
          display:    'none',
          position:   'fixed',
          inset:      '0',
          background: 'rgba(0,0,0,0.55)',
          zIndex:     '100000',
        });
        document.body.appendChild(switchOverlay);
      }

      // ドロップアップメニュー本体
      const switchMenu = document.createElement('div');
      switchMenu.id = 'collab-switch-menu';
      Object.assign(switchMenu.style, _isMobilePage ? {
        // [Mobile] 通知パネルと同じ中央固定表示
        display:        'none',
        position:       'fixed',
        left:           '50%',
        top:            '50%',
        transform:      'translate(-50%, -50%)',
        background:     '#1e1e2e',
        border:         '1px solid rgba(165,214,167,0.40)',
        borderRadius:   '10px',
        minWidth:       '200px',
        width:          'min(320px, 90vw)',
        maxHeight:      'min(400px, 80vh)',
        overflowY:      'auto',
        zIndex:         '100001',
        boxShadow:      '0 8px 40px rgba(0,0,0,0.7)',
        padding:        '4px 0',
        fontFamily:     'monospace',
        fontSize:       '12px',
        pointerEvents:  'none',   // 非表示時はクリックを透過させる
      } : {
        display:        'none',
        position:       'fixed',
        bottom:         '28px',      // ステータスバーの上に展開
        background:     '#1e1e2e',
        border:         '1px solid rgba(165,214,167,0.40)',
        borderRadius:   '6px',
        minWidth:       '200px',
        maxHeight:      '320px',
        overflowY:      'auto',
        zIndex:         '100001',
        boxShadow:      '0 -4px 16px rgba(0,0,0,0.45)',
        padding:        '4px 0',
        fontFamily:     'monospace',
        fontSize:       '12px',
        pointerEvents:  'none',   // 非表示時はクリックを透過させる
      });

      // メニュー内のヘッダー
      const menuHeader = document.createElement('div');
      menuHeader.textContent = 'プロジェクトを選択';
      Object.assign(menuHeader.style, {
        padding:     '5px 12px 4px',
        color:       '#888',
        fontSize:    '10px',
        borderBottom:'1px solid rgba(255,255,255,0.08)',
        marginBottom:'2px',
        userSelect:  'none',
      });
      switchMenu.appendChild(menuHeader);

      // プロジェクト一覧をAPIから取得してメニューを構築
      function buildSwitchMenu() {
        // 既存アイテムをクリア（ヘッダー以外）
        while (switchMenu.children.length > 1) {
          switchMenu.removeChild(switchMenu.lastChild);
        }

        const loading = document.createElement('div');
        loading.textContent = '読み込み中...';
        Object.assign(loading.style, { padding:'8px 12px', color:'#888' });
        switchMenu.appendChild(loading);

        fetch('/WebGantt/api/projects.php', { credentials: 'include' })
          .then(r => r.json())
          .then(data => {
            switchMenu.removeChild(loading);
            const projects = data.projects || [];
            if (projects.length === 0) {
              const empty = document.createElement('div');
              empty.textContent = 'プロジェクトがありません';
              Object.assign(empty.style, { padding:'8px 12px', color:'#888' });
              switchMenu.appendChild(empty);
              return;
            }
            // 個人設定: is_visible=0 は非表示（ただし現在開いているPJは常に表示）
            // sort_order でソート済み（APIがソートして返す）
            const visibleProjects = projects.filter(p =>
              p.is_visible !== 0 || p.project_id === CONFIG.PROJECT_ID
            );
            if (visibleProjects.length === 0) {
              const empty = document.createElement('div');
              empty.textContent = 'プロジェクトがありません';
              Object.assign(empty.style, { padding:'8px 12px', color:'#888' });
              switchMenu.appendChild(empty);
              return;
            }
            visibleProjects.forEach(p => {
              const isCurrent = p.project_id === CONFIG.PROJECT_ID;
              const item = document.createElement('div');
              Object.assign(item.style, {
                display:        'flex',
                alignItems:     'center',
                gap:            '8px',
                padding:        '6px 12px',
                cursor:         isCurrent ? 'default' : 'pointer',
                background:     isCurrent ? 'rgba(165,214,167,0.12)' : 'transparent',
                color:          isCurrent ? '#a5d6a7' : '#ccc',
                borderLeft:     isCurrent ? '2px solid #a5d6a7' : '2px solid transparent',
                transition:     'background 0.1s',
              });
              if (!isCurrent) {
                item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.07)'; };
                item.onmouseleave = () => { item.style.background = 'transparent'; };
              }

              // チェックマーク or スペーサー
              const mark = document.createElement('span');
              mark.textContent = isCurrent ? '✔' : '  ';
              mark.style.fontSize = '11px';
              mark.style.minWidth = '14px';

              // プロジェクト名
              const nameSpan = document.createElement('span');
              nameSpan.textContent = p.name || p.project_id;
              nameSpan.style.flex = '1';
              nameSpan.style.overflow = 'hidden';
              nameSpan.style.textOverflow = 'ellipsis';
              nameSpan.style.whiteSpace = 'nowrap';

              item.appendChild(mark);
              item.appendChild(nameSpan);
              switchMenu.appendChild(item);

              if (!isCurrent) {
                item.addEventListener('click', () => {
                  // プロジェクト切替（WebSocket切断はbeforeunloadで処理）
                  const url = new URL(window.location.href);
                  url.searchParams.set('project', p.project_id);
                  _navigatingTo = url.toString();
                  _navigationAttempted = true;
                  window.location.href = url.toString();
                });
              }
            });
          })
          .catch(() => {
            switchMenu.removeChild(loading);
            const err = document.createElement('div');
            err.textContent = '取得失敗';
            Object.assign(err.style, { padding:'8px 12px', color:'#ef9a9a' });
            switchMenu.appendChild(err);
          });
      }

      // ボタンクリック: メニュー開閉
      // メニュー開閉共通処理
      let menuOpen = false;
      function openMenu() {
        if (_isMobilePage) {
          // [Mobile] 中央固定表示のため位置計算は不要。オーバーレイも表示する。
          if (switchOverlay) switchOverlay.style.display = 'block';
        } else {
          const rect = switchBtn.getBoundingClientRect();
          switchMenu.style.left = rect.left + 'px';
        }
        switchMenu.style.display = 'block';
        switchMenu.style.pointerEvents = 'auto';  // 表示時はクリックを有効化
        menuOpen = true;
        buildSwitchMenu();
      }
      function closeMenu() {
        switchMenu.style.display = 'none';
        switchMenu.style.pointerEvents = 'none';  // 非表示時はクリックを透過
        if (switchOverlay) switchOverlay.style.display = 'none';
        menuOpen = false;
      }

      switchBtn.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (menuOpen) { closeMenu(); } else { openMenu(); }
      };

      // [Mobile] オーバーレイ自体のクリック（メニュー外の暗い部分）で閉じる
      // （通知パネルと同じ挙動。document側の「メニュー外クリック」判定でも
      //  閉じられるため、こちらは無くても機能面は同じだが、通知パネルと
      //  実装を揃えて挙動の一貫性を明示するために追加する）
      if (switchOverlay) {
        switchOverlay.addEventListener('click', function (e) {
          if (e.target === switchOverlay) closeMenu();
        });
      }

      // メニュー外クリックで閉じる（capture:falseでバブルアップのみ受ける）
      document.addEventListener('click', function (e) {
        if (!menuOpen) return;  // 閉じている時は何もしない
        if (!switchMenu.contains(e.target) && e.target !== switchBtn) {
          closeMenu();
        }
      }, false);

      document.body.appendChild(switchMenu);
      // ────────────────────────────────────────────────────────────

      // ─── [Mobile専用] 接続者一覧ボタン ＆ ウィンドウメニュー ───────────
      // PC版のステータスバー上の■表示（renderPresence()、カーソルを乗せると
      // 氏名がtitle属性でツールチップ表示される）には対応するクリック可能な
      // ボタンが存在しないため、モバイル版の統合メニュー(#mobileMenuPresenceBtn)
      // からの委譲先として、非表示の実ボタン(#collab-presence-btn)を新設する。
      // ウィンドウメニュー自体は5.2節の「プロジェクト切替」メニューと全く同じ
      // 見た目・構造（画面中央固定表示＋暗転オーバーレイ）で実装する。
      // PC版（_isMobilePage=false）ではこのブロック自体を生成しないため、
      // PC版の見た目・動作への影響は一切ない。
      let presenceBtn = null;
      if (_isMobilePage) {
        presenceBtn = document.createElement('a');
        presenceBtn.id = 'collab-presence-btn';
        presenceBtn.href = '#';
        presenceBtn.style.display = 'none';  // モバイル統合メニューからのみ使う非表示の委譲先

        const presenceOverlay = document.createElement('div');
        presenceOverlay.id = 'collab-presence-overlay';
        Object.assign(presenceOverlay.style, {
          display:    'none',
          position:   'fixed',
          inset:      '0',
          background: 'rgba(0,0,0,0.55)',
          zIndex:     '100000',
        });
        document.body.appendChild(presenceOverlay);

        const presenceMenu = document.createElement('div');
        presenceMenu.id = 'collab-presence-menu';
        Object.assign(presenceMenu.style, {
          display:        'none',
          position:       'fixed',
          left:           '50%',
          top:            '50%',
          transform:      'translate(-50%, -50%)',
          background:     '#1e1e2e',
          border:         '1px solid rgba(165,214,167,0.40)',
          borderRadius:   '10px',
          minWidth:       '200px',
          width:          'min(320px, 90vw)',
          maxHeight:      'min(400px, 80vh)',
          overflowY:      'auto',
          zIndex:         '100001',
          boxShadow:      '0 8px 40px rgba(0,0,0,0.7)',
          padding:        '4px 0',
          fontFamily:     'monospace',
          fontSize:       '12px',
          pointerEvents:  'none',   // 非表示時はクリックを透過させる
        });

        const presenceMenuHeader = document.createElement('div');
        presenceMenuHeader.id = 'collab-presence-menu-header';
        Object.assign(presenceMenuHeader.style, {
          padding:     '5px 12px 4px',
          color:       '#888',
          fontSize:    '10px',
          borderBottom:'1px solid rgba(255,255,255,0.08)',
          marginBottom:'2px',
          userSelect:  'none',
        });
        presenceMenu.appendChild(presenceMenuHeader);

        // 接続者一覧（_presenceUsers、renderPresence()経由で常に最新化される）を
        // メニュー本体に反映する。ヘッダー行の「接続者(*人)」表示も併せて更新する。
        function renderPresenceMenuItems() {
          presenceMenuHeader.textContent = `接続者(${_presenceUsers.length}人)`;
          while (presenceMenu.children.length > 1) {
            presenceMenu.removeChild(presenceMenu.lastChild);
          }
          if (_presenceUsers.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '接続者がいません';
            Object.assign(empty.style, { padding: '8px 12px', color: '#888' });
            presenceMenu.appendChild(empty);
            return;
          }
          _presenceUsers.forEach((u) => {
            const item = document.createElement('div');
            Object.assign(item.style, {
              display:    'flex',
              alignItems: 'center',
              gap:        '8px',
              padding:    '6px 12px',
            });
            const swatch = document.createElement('span');
            Object.assign(swatch.style, {
              display:      'inline-block',
              width:        '14px',
              height:       '14px',
              borderRadius: '3px',
              background:   u.color || '#888',
              border:       '1.5px solid #fff',
              flexShrink:   '0',
            });
            const nameSpan = document.createElement('span');
            nameSpan.textContent = u.displayName || u.userId;
            nameSpan.style.color = '#ccc';
            nameSpan.style.overflow = 'hidden';
            nameSpan.style.textOverflow = 'ellipsis';
            nameSpan.style.whiteSpace = 'nowrap';
            item.appendChild(swatch);
            item.appendChild(nameSpan);
            presenceMenu.appendChild(item);
          });
        }
        // renderPresence()から呼び出せるよう、IIFEトップレベル変数に登録する。
        _refreshPresenceMenuIfOpen = renderPresenceMenuItems;

        let presenceMenuOpen = false;
        function openPresenceMenu() {
          presenceOverlay.style.display = 'block';
          presenceMenu.style.display = 'block';
          presenceMenu.style.pointerEvents = 'auto';
          presenceMenuOpen = true;
          renderPresenceMenuItems();
        }
        function closePresenceMenu() {
          presenceMenu.style.display = 'none';
          presenceMenu.style.pointerEvents = 'none';
          presenceOverlay.style.display = 'none';
          presenceMenuOpen = false;
        }
        presenceBtn.onclick = function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (presenceMenuOpen) { closePresenceMenu(); } else { openPresenceMenu(); }
        };
        // オーバーレイ自体のクリック（メニュー外の暗い部分）で閉じる
        // （プロジェクト切替・通知パネルと同じ挙動）
        presenceOverlay.addEventListener('click', function (e) {
          if (e.target === presenceOverlay) closePresenceMenu();
        });
        // メニュー外クリックで閉じる（プロジェクト切替メニューと同じ挙動）
        document.addEventListener('click', function (e) {
          if (!presenceMenuOpen) return;
          if (!presenceMenu.contains(e.target) && e.target !== presenceBtn) {
            closePresenceMenu();
          }
        }, false);

        document.body.appendChild(presenceMenu);
        document.body.appendChild(presenceBtn);
      }
      // ────────────────────────────────────────────────────────────

      // 表示順: 同期状態 → ユーザー名 → [ログアウト] [アカウント管理] [プロジェクト管理] [プロジェクト切替▾] → (右端)プレゼンス
      statusBar.appendChild(dot);
      statusBar.appendChild(label);
      statusBar.appendChild(userEl);
      statusBar.appendChild(logoutBtn);
      statusBar.appendChild(accountBtn);
      statusBar.appendChild(projectBtn);
      statusBar.appendChild(switchBtn);
      statusBar.appendChild(presenceEl);
      document.body.appendChild(statusBar);
      if (_isMobilePage) {
        // モバイル版では下部ステータスバーを非表示にする。
        // 内部の要素（projectBtn/accountBtn/logoutBtn/switchBtn等）は
        // DOM上に残しておき、gantt-mobile.html側の統合メニューから
        // id経由でクリックを委譲できるようにする。
        statusBar.style.display = 'none';
      }
      // Phase 4: フィードボタンをステータスバーに追加（presenceEl の左に挿入）
      _initFeedUI(statusBar);
      // 外部連携: Googleカレンダー等からの予定インポート機能ボタンを追加（feedBtnと同パターン）
      // 参照: docs/google-calendar-import-design.md 4.1節
      _initExternalIntegrationUI(statusBar);

      const toastContainer = document.createElement('div');
      toastContainer.id = 'collab-toast-container';
      Object.assign(toastContainer.style, {
        position:      'fixed',
        bottom:        '32px',
        right:         '16px',
        zIndex:        '100000',
        display:       'flex',
        flexDirection: 'column',
        gap:           '6px',
      });
      document.body.appendChild(toastContainer);
    }

    function setStatus(state) {
      const dot   = document.getElementById('collab-dot');
      const label = document.getElementById('collab-label');
      if (!dot || !label) return;
      const MAP = {
        connected:    { color: '#4CAF50', text: '🟢 同期中' },
        disconnected: { color: '#F44336', text: '🔴 切断' },
        error:        { color: '#FF9800', text: '🟠 接続エラー' },
      };
      const s = MAP[state] || { color: '#888', text: '…' };
      dot.style.color = s.color;
      label.textContent = s.text;
    }

    function setMyColor(color) {
      myColor = color;
      // ユーザー名表示の背景色を個人カラーと連動
      const el = document.getElementById('collab-user');
      if (el && color) {
        el.style.background = color;
        el.style.color = calcTextColor(color);
      }
    }

    function renderPresence(users) {
      // [Mobile] 接続者リストは人数・メンバー内容が状況により変動するため、
      // presence_update受信の都度、IIFEトップレベル変数に最新値を保持しておく。
      // モバイル用の「接続者(*人)」メニュー項目・ウィンドウメニュー本体は
      // ここから常に最新の状態を参照する（PC版の既存ロジックには影響しない）。
      _presenceUsers = users || [];
      if (_isMobilePageTop) {
        const presenceMenuBtn = document.getElementById('mobileMenuPresenceBtn');
        if (presenceMenuBtn) presenceMenuBtn.textContent = `接続者(${_presenceUsers.length}人)`;
        // メニュー表示中に人数変動があった場合に備え、開いていれば再構築する。
        if (typeof _refreshPresenceMenuIfOpen === 'function') {
          const menuEl = document.getElementById('collab-presence-menu');
          if (menuEl && menuEl.style.display === 'block') _refreshPresenceMenuIfOpen();
        }
      }
      if (!presenceEl) return;
      presenceEl.innerHTML = '';
      users.forEach((u) => {
        const span = document.createElement('span');
        span.title = u.displayName || u.userId;
        Object.assign(span.style, {
          display:         'inline-block',
          width:           '14px',
          height:          '14px',
          borderRadius:    '3px',   // ●(50%)→□(角丸3px) に変更
          background:      u.color || '#888',
          marginLeft:      '4px',
          verticalAlign:   'middle',
          border:          '1.5px solid #fff',
        });
        presenceEl.appendChild(span);
      });
      const countLabel = document.createElement('span');
      countLabel.textContent = ` ${users.length}人`;
      countLabel.style.color = '#aaa';
      presenceEl.appendChild(countLabel);
    }

    return { init, setStatus, setMyColor, renderPresence };
  })();

  // ════════════════════════════════════════════════════════════
  // Phase 4: ライブ変更フィード（ステータスバー内ボタン → ポップアップ）
  // ════════════════════════════════════════════════════════════
  let _feedList = null;      // フィード項目を入れる div
  let _feedMenu = null;      // ポップアップ本体
  let _feedMenuOpen = false; // メニュー開閉状態
  const FEED_MAX_ITEMS = 50;

  // UI.init() からステータスバーにフィードボタンを追加するために呼ぶ
  function _initFeedUI(statusBarEl) {
    // ─ ポップアップ本体（プロジェクト切替メニューと同構造）─
    _feedMenu = document.createElement('div');
    _feedMenu.id = 'collab-feed-menu';
    Object.assign(_feedMenu.style, {
      display:        'none',
      position:       'fixed',
      bottom:         '28px',
      background:     '#1e1e2e',
      border:         '1px solid rgba(165,214,167,0.40)',
      borderRadius:   '6px',
      width:          '320px',
      maxHeight:      '260px',
      overflowY:      'auto',
      zIndex:         '100001',
      boxShadow:      '0 -4px 16px rgba(0,0,0,0.45)',
      padding:        '0',
      fontFamily:     'monospace',
      fontSize:       '11px',
    });

    // ポップアップヘッダー
    const menuHeader = document.createElement('div');
    Object.assign(menuHeader.style, {
      padding:       '5px 10px',
      color:         '#a5d6a7',
      fontSize:      '10px',
      borderBottom:  '1px solid rgba(255,255,255,0.08)',
      position:      'sticky',
      top:           '0',
      background:    '#1e1e2e',
      display:       'flex',
      justifyContent:'space-between',
      alignItems:    'center',
      userSelect:    'none',
    });
    const menuHeaderTitle = document.createElement('span');
    menuHeaderTitle.textContent = '📢 変更フィード';
    const menuClearBtn = document.createElement('span');
    menuClearBtn.textContent = 'クリア';
    Object.assign(menuClearBtn.style, {
      fontSize: '10px', color: '#888', cursor: 'pointer',
    });
    menuClearBtn.onclick = function (e) {
      e.stopPropagation();
      if (_feedList) _feedList.innerHTML = '';
    };
    menuHeader.appendChild(menuHeaderTitle);
    menuHeader.appendChild(menuClearBtn);
    _feedMenu.appendChild(menuHeader);

    // フィードリスト
    _feedList = document.createElement('div');
    _feedList.id = 'collab-feed-list';
    _feedMenu.appendChild(_feedList);

    document.body.appendChild(_feedMenu);

    // ─ ステータスバー内のフィードボタン ─
    const feedBtn = document.createElement('a');
    feedBtn.id = 'collab-feed-btn';
    feedBtn.href = '#';
    feedBtn.title = '変更フィード';

    // ボタンラベル部
    const feedBtnLabel = document.createElement('span');
    feedBtnLabel.textContent = '📢';

    feedBtn.appendChild(feedBtnLabel);

    // ボタンスタイル（他のボタンと統一）
    Object.assign(feedBtn.style, {
      display:         'inline-flex',
      alignItems:      'center',
      height:          '17px',
      padding:         '0 7px',
      fontSize:        '11px',
      color:           '#a5d6a7',
      background:      'rgba(255,255,255,0.07)',
      border:          '1px solid rgba(165,214,167,0.45)',
      borderRadius:    '4px',
      textDecoration:  'none',
      cursor:          'pointer',
      lineHeight:      '1',
      transition:      'background 0.15s',
    });
    feedBtn.onmouseenter = function () { feedBtn.style.background = 'rgba(255,255,255,0.15)'; };
    feedBtn.onmouseleave = function () { feedBtn.style.background = 'rgba(255,255,255,0.07)'; };

    feedBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (_feedMenuOpen) {
        _closeFeedMenu();
      } else {
        _openFeedMenu(feedBtn);
      }
    };

    // メニュー外クリックで閉じる
    document.addEventListener('click', function (e) {
      if (!_feedMenuOpen) return;
      if (!_feedMenu.contains(e.target) && e.target !== feedBtn) {
        _closeFeedMenu();
      }
    }, false);

    // presenceEl の直前に挿入（presenceEl は statusBar の最後の子）
    const presenceEl = statusBarEl.querySelector('#collab-presence');
    if (presenceEl) {
      statusBarEl.insertBefore(feedBtn, presenceEl);
    } else {
      statusBarEl.appendChild(feedBtn);
    }
  }

  function _openFeedMenu(anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    _feedMenu.style.right = (window.innerWidth - rect.right) + 'px';
    _feedMenu.style.left = 'auto';
    _feedMenu.style.display = 'block';
    _feedMenuOpen = true;
  }

  function _closeFeedMenu() {
    _feedMenu.style.display = 'none';
    _feedMenuOpen = false;
  }

  // ════════════════════════════════════════════════════════════
  // 外部連携: Googleカレンダー等からの予定インポート機能
  // 参照: docs/google-calendar-import-design.md 4.1節
  // ────────────────────────────────────────────────────────────
  // 本ボタンの役割は「ステータスバーへの追加」のみに限定する。
  // クリック時はモーダルUI本体（画面0〜C）を持つ gantt-collab.html 側に
  // カスタムイベント（gantt:openExternalIntegration）で通知するだけであり、
  // モーダルの中身（HTML/CSS/ロジック）は本ファイルには一切実装しない
  // （既存のUI要素・コアロジックには影響を与えない設計。PC版のみ対応、
  // モバイル版への追加は本フェーズのスコープ外）。
  // ════════════════════════════════════════════════════════════
  function _initExternalIntegrationUI(statusBarEl) {
    const btn = document.createElement('a');
    btn.id = 'collab-external-integration-btn';
    btn.href = '#';
    btn.title = '外部カレンダーから予定をインポート';

    const icon = document.createElement('span');
    icon.textContent = '🔗';
    icon.style.marginRight = '3px';
    const label = document.createElement('span');
    label.textContent = '外部連携';

    btn.appendChild(icon);
    btn.appendChild(label);

    // ボタンスタイル（feedBtnと統一）
    Object.assign(btn.style, {
      display:         'inline-flex',
      alignItems:      'center',
      height:          '17px',
      padding:         '0 7px',
      fontSize:        '11px',
      color:           '#a5d6a7',
      background:      'rgba(255,255,255,0.07)',
      border:          '1px solid rgba(165,214,167,0.45)',
      borderRadius:    '4px',
      textDecoration:  'none',
      cursor:          'pointer',
      lineHeight:      '1',
      transition:      'background 0.15s',
    });
    btn.onmouseenter = function () { btn.style.background = 'rgba(255,255,255,0.15)'; };
    btn.onmouseleave = function () { btn.style.background = 'rgba(255,255,255,0.07)'; };

    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('gantt:openExternalIntegration'));
    };

    // feedBtn の直前（＝presenceEl の左隣より一つ手前）に挿入。
    // 表示順: ... [フィード📢] [外部連携🔗] (右端)プレゼンス
    const feedBtnEl = statusBarEl.querySelector('#collab-feed-btn');
    const presenceEl = statusBarEl.querySelector('#collab-presence');
    if (presenceEl) {
      statusBarEl.insertBefore(btn, presenceEl);
    } else if (feedBtnEl) {
      statusBarEl.appendChild(btn);
    } else {
      statusBarEl.appendChild(btn);
    }
  }

  function appendToFeed(message, color, opLabel) {
    if (!_feedList) return; // UI初期化前は無視（initFeedUIはUI.init()で呼ばれる）
    const item = document.createElement('div');
    Object.assign(item.style, {
      padding: '4px 10px', color: '#ccc',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      display: 'flex', alignItems: 'center', gap: '6px',
    });
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      display: 'inline-block', width: '6px', height: '6px',
      borderRadius: '50%', background: color || '#888', flexShrink: '0',
    });
    const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const text = document.createElement('span');
    text.style.overflow = 'hidden';
    text.style.textOverflow = 'ellipsis';
    text.style.whiteSpace = 'nowrap';
    text.textContent = `${time} ${message}`;
    item.appendChild(dot);
    item.appendChild(text);
    _feedList.insertBefore(item, _feedList.firstChild);
    // 最大件数制限
    while (_feedList.children.length > FEED_MAX_ITEMS) {
      _feedList.removeChild(_feedList.lastChild);
    }
  }

  /* ================================================================
     11. トースト通知
  ================================================================ */

  function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('collab-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background:   type === 'error'   ? '#c62828'
                  : type === 'warning' ? '#e65100'
                  :                      '#1565c0',
      color:        '#fff',
      padding:      '8px 14px',
      borderRadius: '6px',
      fontSize:     '12px',
      boxShadow:    '0 2px 8px rgba(0,0,0,0.4)',
      opacity:      '0',
      transition:   'opacity 0.3s',
      maxWidth:     '320px',
      lineHeight:   '1.4',
    });
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 350);
    }, duration);
  }

  /* ================================================================
     12. 初期化
  ================================================================ */

  async function init() {
    async function tryInit() {
      if (window.__ganttBridgeReady) {
        log('初期化開始 project:', CONFIG.PROJECT_ID);

        // Phase 2-A: 認証チェック
        const authed = await checkAuth();
        if (!authed) return;  // ログイン画面へリダイレクト済み

        if (window.__ganttBridge) {
          window.__ganttBridge.sendSnapshot = function () { sendSnapshot(); };
          log('__ganttBridge.sendSnapshot を登録しました');
        }
        UI.init();
        await connect();
        socket && socket.on('connect', flushQueue);

        // Phase 4: オーバーレイ再適用タイマー（ガントチャート再描画後にオーバーレイが消えるのを防ぐ）
        setInterval(function () {
          // リモート選択の再適用
          if (remoteSelections.size > 0) renderRemoteSelections();
          // ロックマスクの再適用（アクティブなロック情報があれば再描画）
          Object.keys(_activeLockOverlays).forEach(function (tid) {
            var info = _activeLockOverlays[tid];
            var existing = document.querySelector('.collab-lock-overlay[data-task-id="' + tid + '"]');
            if (!existing) {
              showLockOverlay(tid, info.color, info.lockedBy);
            }
          });
          // Phase 4-B: 依存線ロックマスク再適用
          Object.keys(_activeDepLockOverlays).forEach(function (did) {
            var info = _activeDepLockOverlays[did];
            var existing = document.querySelector('.collab-dep-lock-overlay[data-dep-id="' + did + '"]');
            if (!existing) {
              showDepLockOverlay(did, info.color, info.lockedBy);
            }
          });
          // Phase 4-C: 注記ロックマスク再適用
          Object.keys(_activeAnnLockOverlays).forEach(function (aid) {
            var info = _activeAnnLockOverlays[aid];
            var existing = document.querySelector('.collab-ann-lock-overlay[data-ann-id="' + aid + '"]');
            if (!existing) {
              showAnnLockOverlay(aid, info.color, info.lockedBy);
            }
          });
        }, 500);

        // ── beforeunloadハンドラ: ナビゲーション時のWebSocket処理 ──
        if (!_beforeUnloadHandlerInstalled) {
          _beforeUnloadHandlerInstalled = true;
          window.addEventListener('beforeunload', function () {
            // ナビゲーション（プロジェクト管理/アカウント管理/プロジェクト切替/ログアウト）の場合
            if (_navigationAttempted) {
              // ページが実際に離れる場合はWebSocketを切断
              try { if (socket) { socket.disconnect(); } } catch (err) {}
              connected = false;
            }
          });
          // pagehide: ページが実際に離れた時のみ発火（キャンセル時は発火しない）
          // sessionStorageクリアのみ実行（ログアウトAPIはlogin.html側で処理）
          window.addEventListener('pagehide', function () {
            if (_isLogoutNavigation) {
              try { sessionStorage.removeItem('gantt_last_project'); } catch (err) {}
            }
          });
          // キャンセル検知: ナビゲーション試行後にタイマーで復旧チェック
          // beforeunloadダイアログ中はJS実行が一時停止し、
          // キャンセル後に再開するとこのタイマーが発火する
          setInterval(function () {
            if (_navigationAttempted) {
              // ページがまだ残っている = 遷移がキャンセルされた
              _navigationAttempted = false;
              _navigatingTo = null;
              _isLogoutNavigation = false;
              // beforeunloadでsocket.disconnect()されたものを再接続
              if (socket && socket.disconnected) {
                log('ナビゲーションキャンセル検知 - WebSocket再接続中');
                socket.connect();
                // 接続完了はonConnectハンドラで connected=true / setStatus('connected') が設定される
              }
            }
          }, 500);
        }
      } else {
        setTimeout(tryInit, 100);
      }
    }
    tryInit();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Phase 4-A: 他ユーザーにロックされているか確認するAPI
  function isTaskLockedByOther(taskId) {
    return taskId != null && Object.prototype.hasOwnProperty.call(_activeLockOverlays, String(taskId));
  }

  window.__collabClient = {
    sendOp,
    requestTaskLock,
    releaseTaskLock,
    requestTaskLockMulti,
    releaseTaskLockMulti,
    requestDepLock,
    releaseDepLock,
    requestAnnLock,
    releaseAnnLock,
    syncSelectionToServer,
    sendSnapshot,
    isTaskLockedByOther,  // Phase 4-A: 他ユーザーロック確認
    getConfig: () => CONFIG,
    getStatus: () => ({ connected, serverVersion, queueLength: opQueue.length }),
    getAuthUser: () => authUser,  // Phase 2-A
  };

  log('collab-client.js ロード完了 (Phase 2-A) SESSION_ID:', SESSION_ID, 'project:', CONFIG.PROJECT_ID);
})();

/* ================================================================
   Phase 5-1: 通知ログ板 — collab-client.js 統合モジュール
   ・最下バー（#collab-status-bar）にベルボタンを動的追加
   ・パネル・トーストも動的生成（HTML側への変更ゼロ）
   ================================================================ */
(function () {
  'use strict';

  // ── 設定 ──────────────────────────────────────────────────────
  const NOTIF_API      = '/WebGantt/api/notifications.php';
  const POLL_INTERVAL  = 60_000;   // 1分ごとポーリング
  const DELAY_CHECK_INTERVAL = 3_600_000; // 1時間ごと遅延チェック
  const TOAST_DURATION = 6_000;    // トースト表示時間(ms)

  // ── 状態 ──────────────────────────────────────────────────────
  let _notifications = [];
  let _currentTab    = 'all';
  let _panelOpen     = false;
  let _pollTimer     = null;
  let _projectId     = null;
  let _isGuest       = true;  // 初期値（認証前に true）
  // 認証状態を動的に確認する関数（collab-client の認証完了を検知）
  function _isGuestNow() {
    // collab-client の getAuthUser() で認証状態を確認
    const u = window.__collabClient && window.__collabClient.getAuthUser
      ? window.__collabClient.getAuthUser()
      : null;
    return !u;
  }
  let _initialized   = false;

  // ── DOM参照（動的生成後にセット） ─────────────────────────────
  let bellBtn, badge, overlay, panel, listCont, toastCont;

  // ── アイコンマップ ────────────────────────────────────────────
  const ICON_MAP = {
    delay_alert:          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="18" height="18" style="vertical-align:middle"><polygon points="50,5 97,93 3,93" fill="#FFCC00" stroke="#1a2a4a" stroke-width="6" stroke-linejoin="round"/><polygon points="45,26 55,26 54,68 46,68" fill="#1a2a4a"/><rect x="45" y="74" width="10" height="10" rx="1" fill="#1a2a4a"/></svg>',
    advance_notice:       '⏰',
    start_advance_notice: '⏰',  // Phase 5-6: 終了予告と同じ時計アイコンに変更
    system:               '📢',
    announcement:         '📢',  // Phase 5-7: アナウンス
    task_assign:          '✅',
    task_unassign:        '➖',
    mention:              '💬',
    _default:             '🔔',
  };
  const getIcon = (t) => ICON_MAP[t] || ICON_MAP._default;

  // ── 経過時間 ──────────────────────────────────────────────────
  function timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60)    return '今';
    if (diff < 3600)  return `${Math.floor(diff / 60)}分前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
    return `${Math.floor(diff / 86400)}日前`;
  }

  // ── Phase 5-7: インライン Markdown パーサー ─────────────────────
  // 対応: **太字** *斜体* ~~打消し~~ `コード` [テキスト](URL) \n改行
  // XSS対策: まずHTMLエスケープ → その後Markdown記法を適用
  // ── Phase 5-7: Markdown除去版(2026-07-21 修正) ─────────────────────
  // ── 入力テキストをHTMLエスケープして改行だけ <br> に変換 ──
  function _renderMarkdownInline(text) {
    if (!text) return '';
    let s = String(text).replace(/\\n/g, '\n');
    s = s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  // ── フィルタ ──────────────────────────────────────────────────
  function getFiltered() {
    if (_currentTab === 'all') return _notifications;
    return _notifications.filter(n => n.category === _currentTab);
  }

  // ── バッジ更新 ────────────────────────────────────────────────
  // Phase 5-6: 開始予告・終了予告はベルカウント対象外
  const BADGE_EXCLUDE_TYPES = new Set(['advance_notice', 'start_advance_notice']);

  function updateBadges() {
    // 既読概念を廃止: バッジは通知総数(開始/終了予告以外)を表示
    const count = _notifications.filter(n => !BADGE_EXCLUDE_TYPES.has(n.type)).length;
    if (badge) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  }

  // ── リスト描画 (Phase 5-6: グルーピングカード形式) ────────────────

  // グループ分類定義（表示順に並べる）
  const GROUP_DEFS = [
    { key: 'announce', label: '📢 アナウンス', types: new Set(['announcement']),                                          headerBg: '#1a1a3a', headerColor: '#82aaff' },  // Phase 5-7
    { key: 'delay',    label: '⚠️ 遅延',      types: new Set(['delay_alert']),                                          headerBg: '#3a1a1a', headerColor: '#ff8080' },
    { key: 'end',      label: '⏰ 終了予告',   types: new Set(['advance_notice']),                                       headerBg: '#2a2a1a', headerColor: '#f5c842' },
    { key: 'start',    label: '⏰ 開始予告',   types: new Set(['start_advance_notice']),                                 headerBg: '#0f2a1a', headerColor: '#50c878' },  // Phase 5-6
    { key: 'other',    label: '💬 その他',     types: new Set(['mention','task_assign','task_unassign','system']),        headerBg: '#252525', headerColor: '#aaaaaa' },
  ];

  function getGroup(type) {
    return GROUP_DEFS.find(g => g.types.has(type)) || GROUP_DEFS[GROUP_DEFS.length - 1];
  }

  // タイトルから残り日数を抽出（ソート用）
  function extractDays(title) {
    const m = title.match(/あと(\d+)日/);
    if (m) return parseInt(m[1], 10);
    if (title.includes('今日')) return 0;
    return Infinity;
  }

  // タスクIDと通知タイプごとに最新1件のみ残す（重複排除）
  function deduplicateByTask(items) {
    const seen = new Map();
    const sorted = [...items].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return sorted.filter(n => {
      const key = n.type + ':' + (n.ref_task_id || n.id);
      if (seen.has(key)) return false;
      seen.set(key, true);
      return true;
    });
  }

  // グループ内を残り日数昇順でソート
  function sortByDays(items) {
    return [...items].sort((a, b) => extractDays(a.title) - extractDays(b.title));
  }

  // 折りたたみ状態を保持
  const _groupCollapsed = { announce: false, delay: false, end: false, start: false, other: false };  // Phase 5-7: announce追加

  // 1件の通知行を生成 (Phase 5-6: アイコンを本文から削除、「・」インデントに変更)
  function buildNotifRow(n) {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display:      'flex',
      alignItems:   'center',
      padding:      '7px 12px 7px 32px',  // Phase 5-6: インデント量を増加
      borderBottom: '1px solid #2a2a2a',
      background:   'transparent',
      cursor:       'default',
    });

    // Phase 5-6: 「・」インデント（アナウンス以外は表示）
    const isAnnouncement = (n.category === 'announcement');
    if (!isAnnouncement) {
      const bulletEl = document.createElement('span');
      bulletEl.textContent = '・';
      Object.assign(bulletEl.style, {
        color: '#888', fontSize: '14px', marginRight: '8px', flexShrink: '0',
      });
      row.appendChild(bulletEl);
    }

    // Phase 5-6: 遅延は赤系、その他は通常色
    const textColor = (n.type === 'delay_alert') ? '#ff7070' : '#e0e0e0';

    // Phase 5-7: タイトル + 本文 のコンテナ（縦並び）
    const textContainer = document.createElement('div');
    Object.assign(textContainer.style, {
      flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px',
    });

    const titleEl = document.createElement('span');
    titleEl.textContent = n.title;
    Object.assign(titleEl.style, {
      fontWeight: 'bold',
      fontSize: '12px', color: textColor,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    textContainer.appendChild(titleEl);

    // Phase 5-7: 本文（body）がある場合は2行目に表示（Markdown常時レンダリング・折りたたみなし）
    if (n.body && n.body.trim() !== '') {
      const bodyEl = document.createElement('div');
      const rendered = _renderMarkdownInline(n.body);
      console.log('[Phase5-7] notif body raw:', JSON.stringify(n.body));
      console.log('[Phase5-7] notif body rendered:', rendered);
      bodyEl.innerHTML = rendered;
      Object.assign(bodyEl.style, {
        fontSize: '11px', color: '#999',
        lineHeight: '1.5', marginTop: '2px',
        whiteSpace: 'normal', wordBreak: 'break-word',
        // 親のflex/alignItems:centerでも確実に表示されるよう
        overflow: 'visible', flexShrink: '0',
      });

      // リンクのクリックが親行に伝播しないよう停止
      bodyEl.addEventListener('click', (e) => e.stopPropagation());
      textContainer.appendChild(bodyEl);
    }

    // 対象タスク選択ボタン
    const taskSelectBtn = document.createElement('button');
    if (n.ref_task_id) {
      taskSelectBtn.textContent = '対象タスク選択';
      Object.assign(taskSelectBtn.style, {
        background: '#2a3a4a', border: '1px solid #4a6070', color: '#a0bcd0',
        borderRadius: '4px', padding: '2px 8px', fontSize: '11px',
        cursor: 'pointer', flexShrink: '0', marginLeft: '8px', whiteSpace: 'nowrap',
      });
      taskSelectBtn.onclick = (e) => {
        e.stopPropagation();
        document.dispatchEvent(new CustomEvent('gantt:selectTaskById', { detail: { taskId: n.ref_task_id } }));
        closePanel();
      };
    } else {
      taskSelectBtn.style.display = 'none';
    }

    const timeEl = document.createElement('span');
    timeEl.textContent = timeAgo(n.created_at);
    Object.assign(timeEl.style, { fontSize:'11px', color:'#555', marginLeft:'8px', flexShrink:'0' });

    const delBtn = document.createElement('button');
    delBtn.textContent = '\u00d7';
    Object.assign(delBtn.style, {
      background:'none', border:'none', color:'#555', fontSize:'15px',
      cursor:'pointer', padding:'0 0 0 6px', flexShrink:'0',
    });
    delBtn.onclick = (e) => { e.stopPropagation(); deleteNotif(n.id); };

    row.appendChild(textContainer);   // Phase 5-7: タイトル + 本文
    // ※アナウンス以外は「・」が既に追加済み
    row.appendChild(taskSelectBtn);
    row.appendChild(timeEl);
    row.appendChild(delBtn);

    return row;
  }

  function renderList() {
    if (!listCont) return;
    const items = deduplicateByTask(getFiltered());

    if (items.length === 0) {
      listCont.innerHTML = '<div style="padding:24px;text-align:center;color:#888;font-size:13px">通知はありません</div>';
      return;
    }
    listCont.innerHTML = '';

    // グループに振り分け
    const groups = {};
    GROUP_DEFS.forEach(g => { groups[g.key] = []; });
    items.forEach(n => {
      const g = getGroup(n.type);
      groups[g.key].push(n);
    });

    GROUP_DEFS.forEach(gDef => {
      const members = sortByDays(groups[gDef.key]);
      if (members.length === 0) return;

      // グループヘッダー
      const header = document.createElement('div');
      Object.assign(header.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '7px 14px',
        background: gDef.headerBg,
        color: gDef.headerColor,
        fontSize: '14px', fontWeight: '700',  // Phase 5-6: ヘッダーフォントを大きく
        cursor: 'pointer',
        userSelect: 'none',
        borderBottom: '1px solid #333',
        position: 'sticky', top: '0', zIndex: '1',
      });

      const headerLeft = document.createElement('span');
      headerLeft.style.display = 'flex';
      headerLeft.style.alignItems = 'center';
      headerLeft.style.gap = '6px';
      // Phase 5-6: アイコンを別spanで大きく表示
      const iconPart  = gDef.label.match(/^(\S+)/)?.[1] || '';
      const labelPart = gDef.label.replace(/^\S+\s*/, '') + '\u3000' + members.length + '件';
      const iconSpanH = document.createElement('span');
      iconSpanH.textContent = iconPart;
      iconSpanH.style.fontSize = '20px';
      iconSpanH.style.lineHeight = '1';
      const labelSpanH = document.createElement('span');
      labelSpanH.textContent = labelPart;
      headerLeft.appendChild(iconSpanH);
      headerLeft.appendChild(labelSpanH);

      const toggleIcon = document.createElement('span');
      toggleIcon.textContent = _groupCollapsed[gDef.key] ? '\u25bc' : '\u25b2';
      toggleIcon.style.fontSize = '10px';

      header.appendChild(headerLeft);
      header.appendChild(toggleIcon);

      // グループボディ
      const groupBody = document.createElement('div');
      groupBody.style.display = _groupCollapsed[gDef.key] ? 'none' : 'block';
      members.forEach(n => groupBody.appendChild(buildNotifRow(n)));

      // 折りたたみトグル
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        _groupCollapsed[gDef.key] = !_groupCollapsed[gDef.key];
        groupBody.style.display = _groupCollapsed[gDef.key] ? 'none' : 'block';
        toggleIcon.textContent   = _groupCollapsed[gDef.key] ? '\u25bc' : '\u25b2';
      });

      listCont.appendChild(header);
      listCont.appendChild(groupBody);
    });
  }

    // ── パネル開閉 ────────────────────────────────────────────────
  function openPanel() {
    if (!overlay) return;
    overlay.style.display = 'block';
    _panelOpen = true;
    renderList();
    // 初回または transform がまだ残っている場合のみ上端を px 固定にセット
    // renderList() 後に呼ぶことで offsetHeight が確定してから計算する
    // → 以後は上端が固定されるため高さ変化は下方向にのみ伸縮する
    if (panel.style.transform !== 'none') {
      const panelH = panel.offsetHeight;
      const panelW = panel.offsetWidth;
      const topPx  = Math.max(20, Math.round((window.innerHeight - panelH) / 2));
      const leftPx = Math.max(0,  Math.round((window.innerWidth  - panelW) / 2));
      panel.style.transform = 'none';
      panel.style.top  = topPx  + 'px';
      panel.style.left = leftPx + 'px';
    }
  }
  function closePanel() {
    if (!overlay) return;
    overlay.style.display = 'none';
    _panelOpen = false;
  }

  // ── API: 通知一覧取得 ─────────────────────────────────────────
  async function loadNotifications() {
    if (!_projectId) return;
    // 認証状態を動的確認（init() 時点では未認証でも後で認証完了している可能性）
    if (_isGuestNow()) return;
    try {
      const url = `${NOTIF_API}?project=${encodeURIComponent(_projectId)}&limit=50`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (data.ok) {
        _notifications = data.notifications || [];
        updateBadges();
        if (_panelOpen) renderList();
      }
    } catch (_) { /* silent */ }
  }

  // ── API: 削除 (既読概念は廃止、「×」で閉じる=削除のみ運用) ──────
  async function deleteNotif(id) {
    try {
      await fetch(`${NOTIF_API}?id=${id}`, { method: 'DELETE', credentials: 'include' });
      _notifications = _notifications.filter(n => n.id !== id);
      updateBadges();
      if (_panelOpen) renderList();
    } catch (_) { /* silent */ }
  }

  // ── トースト通知 ──────────────────────────────────────────────
  function showNotifToast(notif) {
    if (!toastCont) return;
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      background:    '#1e3a5f',
      color:         '#e0e0e0',
      border:        '1px solid #2196f3',
      borderRadius:  '8px',
      padding:       '10px 14px',
      fontSize:      '13px',
      maxWidth:      '320px',
      boxShadow:     '0 4px 12px rgba(0,0,0,0.4)',
      cursor:        'pointer',
      display:       'flex',
      alignItems:    'flex-start',
      gap:           '8px',
      animation:     'notifSlideIn 0.3s ease',
    });
    const toastBody = notif.body ? `<div style="font-size:12px;color:#aaa;margin-top:2px">${notif.body}</div>` : '';
    toast.innerHTML = `<span style="font-size:18px;flex-shrink:0;display:flex;align-items:center">${getIcon(notif.type)}</span>
      <div><div style="font-weight:bold">${notif.title || ''}</div>${toastBody}</div>`;
    toast.onclick = () => { openPanel(); toast.remove(); };
    toastCont.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_DURATION);
  }

  // ── DOM動的生成 ───────────────────────────────────────────────
  function buildUI() {
    /* ベルボタン */
    bellBtn = document.createElement('button');
    bellBtn.id = 'notif-bell-btn';
    bellBtn.title = '通知';
    bellBtn.style.cssText = [
      'background:none', 'border:none', 'color:#ccc', 'cursor:pointer',
      'font-size:15px', 'padding:0 4px', 'position:relative',
      'display:inline-flex', 'align-items:center', 'flex-shrink:0',
    ].join(';');
    bellBtn.textContent = '🔔';
    bellBtn.onclick = (e) => { e.stopPropagation(); _panelOpen ? closePanel() : openPanel(); };

    /* バッジ */
    badge = document.createElement('span');
    badge.id = 'notif-badge';
    badge.style.cssText = [
      'position:absolute', 'top:-4px', 'right:-4px',
      'background:#f44336', 'color:#fff',
      'border-radius:50%', 'font-size:9px',
      'min-width:15px', 'height:15px',
      'display:none', 'justify-content:center', 'align-items:center',
      'font-family:sans-serif', 'font-weight:bold', 'line-height:1',
    ].join(';');
    badge.textContent = '0';
    bellBtn.appendChild(badge);

    /* ── モーダルオーバーレイ（グレーアウト背景） ── */
    overlay = document.createElement('div');
    overlay.id = 'notif-overlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0',
      'background:rgba(0,0,0,0.55)',
      'display:none',              /* openPanel()でblockに変更 */
      'z-index:200000',
    ].join(';');
    /* オーバーレイ自体クリック → 閉じる */
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePanel();
    });

    /* ── モーダルダイアログ本体 ── */
    panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',   /* 水平中央のみ。垂直は openPanel() で top を px 固定 */
      'width:min(640px,90vw)',
      'max-height:min(560px,80vh)',
      'background:#1e1e1e',
      'border:1px solid #444',
      'border-radius:12px',
      'box-shadow:0 8px 40px rgba(0,0,0,0.7)',
      'display:flex', 'flex-direction:column',
      'overflow:hidden',
      'font-family:sans-serif',
      'z-index:200001',
    ].join(';');

    /* ── パネルヘッダー ── */
    const header = document.createElement('div');
    header.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:14px 18px', 'border-bottom:1px solid #333',
      'background:#252525', 'flex-shrink:0',
    ].join(';');

    const headerTitle = document.createElement('span');
    headerTitle.textContent = '🔔 通知';
    headerTitle.style.cssText = 'font-size:15px;font-weight:bold;color:#e0e0e0';

    // ── ドラッグ機能 ──
    (function addDragToPanel() {
      let dragging = false, startX = 0, startY = 0, panelLeft = 0, panelTop = 0;
      header.style.cursor = 'move';
      header.style.userSelect = 'none';

      function getPanelRect() {
        return panel.getBoundingClientRect();
      }

      header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        // transform を解除して left/top を px 固定に切り替え
        const rect = getPanelRect();
        panel.style.transform = 'none';
        panel.style.left = rect.left + 'px';
        panel.style.top  = rect.top  + 'px';  /* ドラッグ前に既に px 固定済みなので実質 no-op */
        panelLeft = rect.left;
        panelTop  = rect.top;
        startX = e.clientX;
        startY = e.clientY;
        dragging = true;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newLeft = panelLeft + dx;
        const newTop  = panelTop  + dy;
        // 画面外に出ないようにクランプ
        const pw = panel.offsetWidth;
        const ph = panel.offsetHeight;
        const clampedLeft = Math.max(0, Math.min(window.innerWidth  - pw, newLeft));
        const clampedTop  = Math.max(0, Math.min(window.innerHeight - ph, newTop));
        panel.style.left = clampedLeft + 'px';
        panel.style.top  = clampedTop  + 'px';
      });

      document.addEventListener('mouseup', () => { dragging = false; });
    })();

    const headerActions = document.createElement('div');
    headerActions.style.cssText = 'display:flex;gap:8px;align-items:center';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = [
      'background:none', 'border:none', 'color:#aaa',
      'font-size:22px', 'cursor:pointer', 'padding:0 4px', 'line-height:1',
    ].join(';');
    closeBtn.title = '閉じる';
    closeBtn.onclick = (e) => { e.stopPropagation(); closePanel(); };

    headerActions.appendChild(closeBtn);
    header.appendChild(headerTitle);
    header.appendChild(headerActions);

    /* ── タブ ── */
    const tabsEl = document.createElement('div');
    tabsEl.style.cssText = [
      'display:flex', 'border-bottom:1px solid #333',
      'background:#252525', 'flex-shrink:0',
    ].join(';');

    const TAB_DEFS = [
      { key: 'all',          label: 'すべて' },
      { key: 'announcement', label: '📢 アナウンス' },  // Phase 5-7
      { key: 'reminder',     label: '📋 リマインダー' },
      { key: 'mention',      label: '💬 メンション' },
    ];
    TAB_DEFS.forEach(({ key, label }) => {
      const tab = document.createElement('button');
      tab.dataset.tab = key;
      tab.textContent = label;
      tab.style.cssText = [
        'background:none', 'border:none', 'color:#888',
        'padding:10px 16px', 'font-size:13px', 'cursor:pointer',
        'border-bottom:2px solid transparent',
        'transition:color 0.2s,border-color 0.2s',
      ].join(';');
      if (key === 'all') {
        tab.style.color = '#2196f3';
        tab.style.borderBottomColor = '#2196f3';
      }
      tab.onclick = (e) => {
        e.stopPropagation();
        _currentTab = key;
        tabsEl.querySelectorAll('button').forEach(b => {
          b.style.color = '#888';
          b.style.borderBottomColor = 'transparent';
        });
        tab.style.color = '#2196f3';
        tab.style.borderBottomColor = '#2196f3';
        renderList();
      };
      tabsEl.appendChild(tab);
    });

    /* ── リストコンテナ ── */
    listCont = document.createElement('div');
    listCont.id = 'notif-list-container';
    listCont.style.cssText = 'overflow-y:auto;flex:1';
    listCont.innerHTML = '<div style="padding:32px;text-align:center;color:#888;font-size:13px">通知はありません</div>';

    panel.appendChild(header);
    panel.appendChild(tabsEl);
    panel.appendChild(listCont);
    overlay.appendChild(panel);

    /* ── トーストコンテナ ── */
    toastCont = document.createElement('div');
    toastCont.id = 'notif-toast-container';
    toastCont.style.cssText = [
      'position:fixed', 'bottom:32px', 'right:8px',
      'z-index:200001', 'display:flex', 'flex-direction:column', 'gap:6px',
      'pointer-events:none',
    ].join(';');
    toastCont.style.pointerEvents = 'none';

    /* ── アニメーション ── */
    const animStyle = document.createElement('style');
    animStyle.textContent = `
      @keyframes notifSlideIn {
        from { opacity:0; transform:translateX(20px); }
        to   { opacity:1; transform:translateX(0); }
      }
      @keyframes notifModalIn {
        from { opacity:0; transform:scale(0.95); }
        to   { opacity:1; transform:scale(1); }
      }
      #notif-panel { animation: notifModalIn 0.18s ease; }
      #notif-toast-container > * { pointer-events:auto; }
    `;
    document.head.appendChild(animStyle);

    document.body.appendChild(overlay);
    document.body.appendChild(toastCont);
  }

  // ── ステータスバーへベルを挿入 ────────────────────────────────
  function insertBellToStatusBar() {
    // presenceEl の左隣（右端グループ手前）に挿入
    const bar = document.getElementById('collab-status-bar');
    if (!bar) return false;
    const presence = document.getElementById('collab-presence');
    if (presence) {
      bar.insertBefore(bellBtn, presence);
    } else {
      bar.appendChild(bellBtn);
    }
    return true;
  }

  // ── 初期化 ────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;

    // プロジェクトIDを取得
    const params = new URLSearchParams(window.location.search);
    _projectId = params.get('project');

    // ゲスト判定（collab-client.jsの認証情報を参照）
    // ※ authUser は非同期取得のため、初期化直後は null の場合がある
    // → _isGuest は初期値 true のままとし、各関数内で _isGuestNow() により動的判定する
    _isGuest = _isGuestNow(); // 現時点での認証状態（未認証なら true）

    buildUI();

    // ステータスバーへの挿入を試みる（バーがまだなければ待機）
    if (!insertBellToStatusBar()) {
      const obs = new MutationObserver(() => {
        if (insertBellToStatusBar()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: false });
    }

    // ガントデータ読み込み完了時にも遅延チェックを実行
    document.addEventListener('gantt:remoteLoad', () => {
      if (_projectId) {
        // データ読み込み後 2 秒待ってチェック（レンダリング完了を待つ）
        setTimeout(() => checkAndSendDelayAlerts(), 2000);
      }
    }, { once: true }); // 初回読み込みのみ

    // WebSocketイベント受信
    document.addEventListener('gantt:notification', (e) => {
      const notif = e.detail;
      // Phase 5-6: 同タスク・同タイプの通知は最新に上書き
      const dupKey2 = notif.type + ':' + (notif.ref_task_id || '');
      if (notif.ref_task_id) {
        const idx2 = _notifications.findIndex(n => n.type === notif.type && n.ref_task_id === notif.ref_task_id);
        if (idx2 !== -1) _notifications.splice(idx2, 1);
      }
      _notifications.unshift(notif);
      updateBadges();
      if (_panelOpen) renderList();
      showNotifToast(notif);
    });

    // 認証完了前でもタイマーを登録（関数内で動的に認証状態を判定）
    // ※ 初回 loadNotifications は認証未完了なら即 return するが、
    //    その後ポーリングで認証完了後に自動的に取得が始まる
    if (_projectId) {
      loadNotifications(); // 認証前なら即 return（无害）
      _pollTimer = setInterval(loadNotifications, POLL_INTERVAL);

      // フェーズ5-3: 遅延アラートチェック（起動時 + 1時間ごと）
      setTimeout(() => checkAndSendDelayAlerts(), 10000); // ガント初期化待ち
      setInterval(() => checkAndSendDelayAlerts(), DELAY_CHECK_INTERVAL);

      // フェーズ5-6: 予定予告（備忘録）チェック（起動時 + 1時間ごつ）
      setTimeout(() => checkAndSendAdvanceNotices(), 12000); // 遅延チェックの2秒後
      setInterval(() => checkAndSendAdvanceNotices(), DELAY_CHECK_INTERVAL);
    }

    _initialized = true;
    console.log('[Notification] Phase 5-1 モジュール初期化完了 project:', _projectId, 'guest(initial):', _isGuest, '(動的判定は各関数で実施)');
  }

  // DOMContentLoaded または即時実行
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── フェーズ5-3: 遅延タスク検出 & アラート送信 ──────────────────
  /**
   * ガントチャートの state.tasks を走査し、遅延タスクを検出して
   * notifications.php (action=create_delay_alert) へ記録する。
   * 当日分は PHP 側で重複スキップするため複数回呼んでも安全。
   */
  async function checkAndSendDelayAlerts() {
    // ゲスト判定を再確認（init() 時点では認証が完了していない場合があるため）
    if (!_projectId) return;
    // collab-client の認証情報を再取得して確認
    const _currentAuthUser = window.__collabClient && window.__collabClient.getAuthUser
      ? window.__collabClient.getAuthUser()
      : null;
    if (!_currentAuthUser) {
      // 認証未完了の場合は 10 秒後に再試行（最大1回）
      console.log('[Notification] checkAndSendDelayAlerts: 認証未完了、10秒後に再試行');
      setTimeout(() => checkAndSendDelayAlerts(), 10000);
      return;
    }
    // ガントチャートの state を参照（グローバルに公開されていなければリトライ）
    const ganttState = window.__ganttState;
    if (!ganttState || !Array.isArray(ganttState.tasks)) {
      // __ganttState 未設定の場合は 10 秒後に再試行
      console.log('[Notification] checkAndSendDelayAlerts: __ganttState 未設定、10秒後に再試行');
      setTimeout(() => checkAndSendDelayAlerts(), 10000);
      return;
    }

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));

    // 遅延タスクを抽出（status が not_started / in_progress かつ end < today）
    const delayedTasks = ganttState.tasks.filter((task) => {
      const base = task.status || 'not_started';
      if (base !== 'not_started' && base !== 'in_progress') return false;
      if (!task.end) return false;
      const endDate = parseDateStr(task.end);
      if (!endDate) return false;
      return todayUTC > endDate;
    });

    console.log('[Notification] checkAndSendDelayAlerts: 遅延タスク数=', delayedTasks.length, 'project=', _projectId);
    if (delayedTasks.length > 0) {
      console.log('[Notification] 遅延タスク詳細:', JSON.stringify(delayedTasks.map(t => ({id: t.id, name: t.name, end: t.end, status: t.status}))));
    }
    if (delayedTasks.length === 0) return;

    // 1リクエストで全遅延タスクをまとめて送信
    try {
      const payload = {
        action: 'create_delay_alert',
        project_id: _projectId,
        delayed_tasks: delayedTasks.map((t) => ({
          task_id:   t.id   || '',
          task_name: t.name || 'タスク',
          end:       t.end  || '',
          assignee_user_ids: Array.isArray(t.assigneeUserId)
            ? t.assigneeUserId.map(Number).filter(Boolean)
            : (t.assigneeUserId ? [Number(t.assigneeUserId)] : []),
        })),
      };
      const res = await fetch('/WebGantt/api/notifications.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.created_notifications) && data.created_notifications.length > 0) {
        // 自分宛の新規遅延通知があればリロード
        const myUserId = _currentAuthUser ? Number(_currentAuthUser.id || 0) : 0;
        if (myUserId && data.created_notifications.some((n) => Number(n.user_id) === myUserId)) {
          loadNotifications();
        }
      }
    } catch (_) { /* silent */ }
  }

  // ── フェーズ5-6: 予定予告（備忘録）通知 ──────────────────
  /**
   * ガントチャートの state.tasks を走査し、期限がN日以内の未完了タスクを
   * 検出して notifications.php (action=create_advance_notice) へ記録する。
   * ※N日数はサーバー側の project_notification_settings.notify_advance_days で制御される。
   *   ここではクライアント側で広め（30日）に拾って送信し、サーバー側でフィルタする。
   *   当日分は PHP 側で重複スキップするため複数回呼んでも安全。
   */
  async function checkAndSendAdvanceNotices() {
    if (!_projectId) return;
    const _currentAuthUser = window.__collabClient && window.__collabClient.getAuthUser
      ? window.__collabClient.getAuthUser()
      : null;
    if (!_currentAuthUser) {
      console.log('[Notification] checkAndSendAdvanceNotices: 認証未完了、10秒後に再試行');
      setTimeout(() => checkAndSendAdvanceNotices(), 10000);
      return;
    }
    const ganttState = window.__ganttState;
    if (!ganttState || !Array.isArray(ganttState.tasks)) {
      console.log('[Notification] checkAndSendAdvanceNotices: __ganttState 未設定、10秒後に再試行');
      setTimeout(() => checkAndSendAdvanceNotices(), 10000);
      return;
    }

    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const UPCOMING_MAX_DAYS = 30; // クライアント側は広めに拾う（サーバー側で設定に基づきフィルタ）

    // 期限がN日以内の未完了タスクを抽出（過去の遅延タスクは除外）
    // 開始予告: not_startedのみ、task.startをチェック
    // 終了予告: not_started / in_progress、task.endをチェック
    const upcomingTasks = [];
    for (const task of ganttState.tasks) {
      const base = task.status || 'not_started';
      if (base !== 'not_started' && base !== 'in_progress') continue;

      const taskStart = task.start || '';
      const taskEnd   = task.end   || '';

      // 終了日チェック
      let endDiffDays = -1;
      if (taskEnd) {
        const endDate = parseDateStr(taskEnd);
        if (endDate) {
          endDiffDays = Math.ceil((endDate - todayUTC) / (1000 * 60 * 60 * 24));
        }
      }

      // 開始日チェック (not_startedのみ)
      let startDiffDays = -1;
      if (base === 'not_started' && taskStart) {
        const startDate = parseDateStr(taskStart);
        if (startDate) {
          startDiffDays = Math.ceil((startDate - todayUTC) / (1000 * 60 * 60 * 24));
        }
      }

      // 終了予告対象: 0 <= endDiffDays <= 30
      // 開始予告対象: 0 <= startDiffDays <= 30
      if (endDiffDays < 0 || endDiffDays > UPCOMING_MAX_DAYS) endDiffDays = -1;
      if (startDiffDays < 0 || startDiffDays > UPCOMING_MAX_DAYS) startDiffDays = -1;

      // どちらかが対象なら送信リストに追加
      if (endDiffDays >= 0 || startDiffDays >= 0) {
        upcomingTasks.push({ task, endDiffDays, startDiffDays });
      }
    }

    console.log('[Notification] checkAndSendAdvanceNotices: 期限接近タスク数=', upcomingTasks.length, 'project=', _projectId);
    if (upcomingTasks.length === 0) return;

    // 1リクエストで全期限接近タスクをまとめて送信
    try {
      const payload = {
        action: 'create_advance_notice',
        project_id: _projectId,
        upcoming_tasks: upcomingTasks.map(({ task, endDiffDays, startDiffDays }) => ({
          task_id:   task.id   || '',
          task_name: task.name || 'タスク',
          end:       task.end  || '',
          start:     task.start || '',
          status:    task.status || 'not_started',
          days_until: endDiffDays >= 0 ? endDiffDays : -1,
          start_days_until: startDiffDays >= 0 ? startDiffDays : -1,
          assignee_user_ids: Array.isArray(task.assigneeUserId)
            ? task.assigneeUserId.map(Number).filter(Boolean)
            : (task.assigneeUserId ? [Number(task.assigneeUserId)] : []),
        })),
      };
      const res = await fetch('/WebGantt/api/notifications.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.created_notifications) && data.created_notifications.length > 0) {
        const myUserId = _currentAuthUser ? Number(_currentAuthUser.id || 0) : 0;
        if (myUserId && data.created_notifications.some((n) => Number(n.user_id) === myUserId)) {
          loadNotifications();
        }
      }
    } catch (_) { /* silent */ }
  }

  /**
   * "YYYY-MM-DD" 形式の文字列を UTC Date に変換
   */
  function parseDateStr(str) {
    if (!str) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  // 認証完了後に呼び出す再アクティベート関数（Phase 5-3）
  function reactivate() {
    const wasGuest = _isGuest;
    _isGuest = _isGuestNow();
    console.log('[Notification] reactivate: _isGuest =', _isGuest, '(was:', wasGuest + ')');
    if (!_isGuest && _projectId) {
      // 認証完了 → 即座に通知を取得
      loadNotifications();
      // 遅延チェックも即実行（ガントデータが既にあれば）
      if (window.__ganttState && Array.isArray(window.__ganttState.tasks)) {
        checkAndSendDelayAlerts();
        // フェーズ5-6: 予定予告チェックも即実行
        setTimeout(() => checkAndSendAdvanceNotices(), 2000);
      }
    }
  }

  // 外部API
  window.__notificationModule = {
    reload:    loadNotifications,
    showToast: showNotifToast,
    addNotif:  (notif) => {
      // Phase 5-6: 同タスク・同タイプの通知は最新に上書き
      const dupKey = notif.type + ':' + (notif.ref_task_id || '');
      if (dupKey !== notif.type + ':') {
        const idx = _notifications.findIndex(n => n.type === notif.type && n.ref_task_id === notif.ref_task_id);
        if (idx !== -1) _notifications.splice(idx, 1);
      }
      _notifications.unshift(notif);
      updateBadges();
      if (_panelOpen) renderList();
    },
    checkDelayAlerts: checkAndSendDelayAlerts,  // フェーズ5-3: 外部から呼び出し可能
    checkAdvanceNotices: checkAndSendAdvanceNotices, // フェーズ5-6: 外部から呼び出し可能
    reactivate: reactivate,                      // フェーズ5-3: 認証完了後に呼ぶ
  };
})();