/**
 * ガントチャート協調編集 WebSocket サーバー (Phase 2-C + Teams Excel連携 full_sync強制配信)
 * =====================================================
 * Teams共有Excel連携（拡張機能方式）対応（2026-08-19、WebGantt本サンドボックス管理へ移行）:
 *   - 新規エンドポイント POST /internal/full_sync_push を追加。
 *     api/teams_excel_import.php（拡張機能からのDB直接書き込み）が
 *     projects.snapshot を更新した直後にこれを呼び出すことで、当該
 *     プロジェクトをメモリ上に room として保持している（＝誰かが
 *     ブラウザで開いている）場合、その room.snapshot を最新化し、
 *     接続中の全クライアントへ既存の full_sync イベントを配信する。
 *   - これにより、「拡張機能でDBを直接更新した後、開いていたブラウザが
 *     リロード/切断時に古いメモリ上のsnapshotをDBへ再保存してしまい、
 *     インポートしたタスクが消える」という事故を防止する。
 *   - collab-client.js側の変更は不要（既存の onFullSync() をそのまま利用）。
 *
 * Phase 2-C 変更点:
 *   - task_op 受信時に operation_logs テーブルへ操作履歴を保存
 *   - join_project 応答に pendingOps を追加（差分同期による遅延参加者の復元）
 *   - ユーザー参加/離脱時の通知イベント（user_join/user_leave）を送信
 *   - 編集ロック機能（task_lock/task_unlock）と競合検出（LWW通知）
 *   - Phase 4: タスク選択同期（task_select）、ロック状態の色付き通知強化
 *
 * Phase 2-B 変更点:
 *   - join_project 時にプロジェクトアクセス権限をチェック
 *   - アクセス権限のないプロジェクトへの接続を拒否
 *   - admin は全プロジェクトに強制アクセス可能
 *
 * Phase 2-A 変更点:
 *   - join_project 時に認証トークンを検証（DB照合）
 *   - 未認証の場合はゲストとして扱う（後方互換）
 *   - 操作ログにユーザー名を記録
 *
 * 依存: npm install express socket.io cors mysql2
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const mysql     = require('mysql2/promise');

// ─── 設定 ──────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';

const DB_CONFIG = {
  host:     process.env.DB_HOST || '127.0.0.1',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  user:     process.env.DB_USER || 'gantt_app',
  password: process.env.DB_PASS || 'gantt_pass',
  database: process.env.DB_NAME || 'gantt_collab',
  charset:  'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

const pool = mysql.createPool(DB_CONFIG);

async function testDbConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    console.log('[DB] MySQL接続成功:', `${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  } catch (err) {
    console.error('[DB] MySQL接続エラー:', err.message);
    console.error('[DB] DBなしでもWebSocketサーバーは起動します（永続化なし・認証なし）');
  }
}

// ═══════════════════════════════════════════════════════════
// 認証関連 (Phase 2-A)
// ═══════════════════════════════════════════════════════════

/**
 * 認証トークン（セッションID）を検証
 * @returns {Promise<{id, username, displayName, role}|null>}
 */
async function verifyAuthToken(sessionId) {
  if (!sessionId) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT s.id as sess_id, u.id, u.username, u.display_name, u.role
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.id = ? AND s.expires_at > NOW()`,
      [sessionId]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id:          row.id,
      username:    row.username,
      displayName: row.display_name,
      role:        row.role,
    };
  } catch (err) {
    console.error('[Auth] トークン検証エラー:', err.message);
    return null;
  }
}

/**
 * プロジェクトアクセス権限チェック (Phase 2-B)
 * @param {number} userId - users.id
 * @param {string} role - users.role ('admin' / 'user')
 * @param {string} projectId - プロジェクト識別子
 * @returns {Promise<boolean>} アクセス可能なら true
 */
async function checkProjectAccess(userId, role, projectId) {
  // 管理者は全プロジェクトにアクセス可能
  if (role === 'admin') return true;
  if (!userId) return false;
  try {
    const [rows] = await pool.execute(
      'SELECT id FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, userId]
    );
    return rows.length > 0;
  } catch (err) {
    console.error('[Auth] プロジェクトアクセス権限チェックエラー:', err.message);
    // DB エラーの場合は安全側に倒れて拒否
    return false;
  }
}

// ─── スナップショット保存（デバウンス付き） ────────────────
const saveQueue = new Map();
const SAVE_DEBOUNCE_MS = 2000;

function scheduleSaveToDb(projectId, snapshot, version) {
  const existing = saveQueue.get(projectId);
  if (existing && existing.timer) clearTimeout(existing.timer);

  const entry = { snapshot, version, timer: null };
  entry.timer = setTimeout(async () => {
    await saveToDb(projectId, snapshot, version);
    saveQueue.delete(projectId);
  }, SAVE_DEBOUNCE_MS);
  saveQueue.set(projectId, entry);
}

async function saveToDbNow(projectId, snapshot, version) {
  const existing = saveQueue.get(projectId);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
    saveQueue.delete(projectId);
  }
  await saveToDb(projectId, snapshot, version);
}

async function saveToDb(projectId, snapshot, version) {
  try {
    const snapshotJson = JSON.stringify(snapshot);
    const snapshotSize = Buffer.byteLength(snapshotJson, 'utf8');

    await pool.execute(
      `INSERT INTO projects (project_id, name, snapshot, snapshot_size, version)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         snapshot = VALUES(snapshot),
         snapshot_size = VALUES(snapshot_size),
         version = VALUES(version),
         updated_at = CURRENT_TIMESTAMP`,
      [projectId, snapshot?.project?.name || '', snapshotJson, snapshotSize, version || 0]
    );

    // 保存したスナップショットのバージョンを記録（差分同期の基準点）
    const room = rooms.get(projectId);
    if (room) {
      room.snapshotVersion = version;
      // 保存済みのバージョン以下のopsをメモリから破棄（古いopsの蓄積を防止）
      if (room.ops.length > 0) {
        const beforeCount = room.ops.length;
        room.ops = room.ops.filter(op => op.version > version);
        if (room.ops.length < beforeCount) {
          console.log(`[DB] ops整理: ${beforeCount} → ${room.ops.length} (snapshot v${version}) project:${projectId}`);
        }
      }
    }
    console.log(`[DB] saved project:${projectId} v${version} size:${snapshotSize}bytes`);
  } catch (err) {
    console.error(`[DB] save error project:${projectId}:`, err.message);
  }
}

// ─── 操作ログ保存（operation_logs テーブル） ───────────────
async function saveOpLog(projectId, op, version) {
  try {
    const opType    = op.type || 'unknown';
    // payload全体をJSONとして保存（type以外の全フィールド）
    const opPayload = JSON.stringify(op.payload || op);
    const userId    = op.userId || null;
    const sessionId = op.sessionId || null;

    await pool.execute(
      `INSERT INTO operation_logs (project_id, op_type, op_payload, version, user_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, opType, opPayload, version, userId, sessionId]
    );
  } catch (err) {
    // 操作ログの保存失敗は同期に影響させない（警告のみ）
    console.error(`[DB] op_log save error project:${projectId} v${version}:`, err.message);
  }
}

async function loadFromDb(projectId) {
  try {
    const [rows] = await pool.execute(
      'SELECT snapshot, version FROM projects WHERE project_id = ?',
      [projectId]
    );
    if (rows.length === 0) return { snapshot: null, version: 0 };

    const row = rows[0];
    let snapshot = null;
    if (row.snapshot) {
      snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    }
    return { snapshot, version: row.version || 0 };
  } catch (err) {
    console.error(`[DB] load error project:${projectId}:`, err.message);
    return { snapshot: null, version: 0 };
  }
}

// ─── Express ────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    res.json({ status: 'ok', db: true, ts: Date.now() });
  } catch {
    res.json({ status: 'ok', db: false, ts: Date.now() });
  }
});

// ── Phase 5-2: PHP → WebSocket 通知ブリッジ ──────────────
// POST /push_notification
//   body: { target_user_ids: [1,2,...], notification: {...} }
//   PHP（notifications.php）から呼ばれ、対象ユーザーへリアルタイム通知を配信する
app.post('/push_notification', (req, res) => {
  const { target_user_ids, notification } = req.body || {};
  if (!notification || !Array.isArray(target_user_ids) || target_user_ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'target_user_ids and notification are required' });
  }
  let pushed = 0;
  for (const [projId, room] of rooms) {
    for (const [sockId, clientInfo] of room.clients) {
      if (clientInfo.dbUserId && target_user_ids.includes(clientInfo.dbUserId)) {
        io.to(sockId).emit('notification_received', notification);
        pushed++;
      }
    }
  }
  res.json({ ok: true, pushed });
});

// POST /push_notification_batch  (Phase 5-7)
//   body: { notifications: [ { user_id, type, title, ... }, ... ] }
//   PHP から一括で送信され、各通知を該当ユーザーへ配信する
app.post('/push_notification_batch', (req, res) => {
  const { notifications } = req.body || {};
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return res.status(400).json({ ok: false, error: 'notifications array is required' });
  }
  let pushed = 0;
  for (const notif of notifications) {
    const targetUserId = notif.user_id;
    if (!targetUserId) continue;
    for (const [projId, room] of rooms) {
      for (const [sockId, clientInfo] of room.clients) {
        if (clientInfo.dbUserId && clientInfo.dbUserId === targetUserId) {
          io.to(sockId).emit('notification_received', notif);
          pushed++;
        }
      }
    }
  }
  res.json({ ok: true, pushed });
});

// ── Teams共有Excel連携: DB直接書き込み後のメモリ状態強制同期 ──
// POST /internal/full_sync_push
//   body: { projectId, snapshot, version }
//   api/teams_excel_import.php（import_tasks）が projects.snapshot を
//   直接UPDATEした直後に呼び出される。対象プロジェクトが現在メモリ上に
//   room として存在する（＝誰かがブラウザで開いている）場合のみ、
//   room.snapshot / room.version / room.snapshotVersion を最新化し、
//   既存の full_sync イベントで接続中クライアント全員へ配信する。
//   room が存在しない（誰も開いていない）場合はDBが既に正しい状態のため
//   何もしない（次に誰かが開いた時に loadFromDb() で正しく読み込まれる）。
app.post('/internal/full_sync_push', (req, res) => {
  const { projectId, snapshot, version } = req.body || {};
  if (!projectId || !snapshot) {
    return res.status(400).json({ ok: false, error: 'projectId and snapshot are required' });
  }
  const room = rooms.get(projectId);
  if (!room) {
    // 誰も開いていない → DBは既に最新のため何もしない
    return res.json({ ok: true, pushed: false, reason: 'room_not_found' });
  }

  const newVersion = (typeof version === 'number') ? version : room.version;
  room.snapshot = snapshot;
  room.version = Math.max(room.version, newVersion);
  room.snapshotVersion = room.version;

  io.to(projectId).emit('full_sync', { version: room.version, snapshot: room.snapshot });
  console.log(`[internal] full_sync_push project:${projectId} v${room.version} → ${room.clients.size}クライアントへ配信`);
  res.json({ ok: true, pushed: true, clientCount: room.clients.size, version: room.version });
});

// ─── Socket.IO ─────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── プロジェクトごとの状態管理 ──────────────────────────
const rooms = new Map();
const MAX_OPS_LOG = 500;

function getOrCreateRoom(projectId) {
  if (!rooms.has(projectId)) {
    rooms.set(projectId, {
      version: 0, snapshot: null, snapshotVersion: 0, ops: [], clients: new Map(), dbLoaded: false,
      taskLocks: new Map(), // Phase 3: taskId → { socketId, userId, displayName, ts }
      depLocks: new Map(),  // Phase 4-B: depId → { socketId, userId, displayName, ts }
      annLocks: new Map(),  // Phase 4-C: annId → { socketId, userId, displayName, ts }
    });
  }
  return rooms.get(projectId);
}

const USER_COLORS = ['#E53935','#8E24AA','#1E88E5','#00ACC1','#43A047','#FB8C00','#6D4C41','#757575'];
let colorIdx = 0;
function nextColor() { return USER_COLORS[colorIdx++ % USER_COLORS.length]; }

function broadcastPresence(projectId) {
  const room = rooms.get(projectId);
  if (!room) return;
  const users = [];
  for (const [sid, info] of room.clients) users.push({ socketId: sid, ...info });
  io.to(projectId).emit('presence_update', { users });
}

function appendOp(room, op) {
  room.ops.push(op);
  if (room.ops.length > MAX_OPS_LOG) room.ops.shift();
}

// ─── Socket.IO イベント ──────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  let currentProjectId = null;
  let currentUserId    = null;
  let currentUserInfo     = null;  // Phase 2-A: 認証済みユーザー情報
  let _effectiveDisplayName = null; // Phase 3: 接続スコープの表示名（task_op等から参照用）

  // ── join_project ────────────────────────────────────
  socket.on('join_project', async (data, ack) => {
    const { projectId, userId, displayName, authToken } = data || {};
    if (!projectId || !userId) {
      if (typeof ack === 'function') ack({ error: 'projectId と userId は必須です' });
      return;
    }

    if (currentProjectId && currentProjectId !== projectId) {
      leaveRoom(socket, currentProjectId);
    }

    currentProjectId = projectId;
    currentUserId    = userId;

    // ★ Phase 2-A: 認証トークン検証
    let effectiveDisplayName = displayName || userId;
    let dbUserId = null;       // users.id (Phase 2-B)
    let dbUserRole = 'guest';  // users.role (Phase 2-B)
    if (authToken) {
      const authUser = await verifyAuthToken(authToken);
      if (authUser) {
        currentUserInfo = authUser;
        currentUserId = authUser.username;
        effectiveDisplayName = authUser.displayName;
        _effectiveDisplayName = effectiveDisplayName; // 接続スコープに保存
        dbUserId = authUser.id;
        dbUserRole = authUser.role;
        console.log(`[auth] ${socket.id} → user:${authUser.username} (${authUser.displayName}) role:${authUser.role}`);
      } else {
        console.log(`[auth] ${socket.id} → 認証失敗、ゲストとして扱う`);
        _effectiveDisplayName = effectiveDisplayName; // 接続スコープに保存
      }
    }

    // ★ Phase 2-B: プロジェクトアクセス権限チェック
    if (dbUserId !== null) {
      const hasAccess = await checkProjectAccess(dbUserId, dbUserRole, projectId);
      if (!hasAccess) {
        console.log(`[auth] ${socket.id} → プロジェクト ${projectId} へのアクセス拒否 (user:${currentUserId})`);
        if (typeof ack === 'function') {
          ack({ error: 'このプロジェクトにアクセスする権限がありません', code: 'ACCESS_DENIED' });
        }
        return;
      }
    }

    const room = getOrCreateRoom(projectId);
    socket.join(projectId);

    if (!room.dbLoaded) {
      console.log(`[DB] loading project:${projectId} from database...`);
      const dbData = await loadFromDb(projectId);
      room.snapshot = dbData.snapshot;
      room.version  = dbData.version;
      room.snapshotVersion = dbData.version;
      room.dbLoaded = true;
      console.log(`[DB] loaded project:${projectId} v${room.version} snapshot:${dbData.snapshot ? 'yes' : 'no'}`);
    }

    const color = nextColor();
    room.clients.set(socket.id, {
      userId: currentUserId,
      dbUserId: dbUserId,           // Phase 5-1: users.id (数値) 通知プッシュ用
      displayName: effectiveDisplayName,
      color,
      joinedAt: Date.now(),
      authUser: currentUserInfo,  // Phase 2-A
    });

    console.log(`[join] ${effectiveDisplayName} → room:${projectId} (v${room.version}) snapshot:${room.snapshot ? 'yes' : 'no'}`);

    // Phase 2-C: 差分同期 — スナップショット以降の未適用操作を抽出
    let pendingOps = [];
    if (room.snapshot && room.ops.length > 0) {
      // スナップショットのバージョン以降のopsを取得
      const snapshotVersion = room.snapshotVersion || 0;
      pendingOps = room.ops.filter(op => op.version > snapshotVersion);
      if (pendingOps.length > 0) {
        console.log(`[join] 差分ops送信: ${pendingOps.length}件 (snapshot v${snapshotVersion} → current v${room.version}) room:${projectId}`);
      }
    }

    if (typeof ack === 'function') {
      ack({ ok: true, version: room.version, snapshot: room.snapshot, color, pendingOps });
    }

    // スナップショットがない場合、既存クライアントにブロードキャストするよう依頼
    if (!room.snapshot && room.clients.size > 1) {
      // 既存クライアントにスナップショット送信を依頼する
      socket.to(projectId).emit('snapshot_request', { requesterId: socket.id, projectId });
      console.log(`[join] snapshotがないため既存クライアントに送信依頼 room:${projectId}`);
    }

    broadcastPresence(projectId);

    // Phase 2-C: ユーザー参加通知（自分以外に送信）
    if (room.clients.size > 1) {
      socket.to(projectId).emit('user_join', {
        displayName: effectiveDisplayName,
        userId: currentUserId,
        ts: Date.now(),
      });
    }
  });

  // ── task_op ─────────────────────────────────────────
  socket.on('task_op', (data, ack) => {
    const { projectId, sessionId, baseVersion, op } = data || {};
    if (!projectId || !op) {
      if (typeof ack === 'function') ack({ error: 'projectId と op は必須です' });
      return;
    }

    const room = rooms.get(projectId);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'プロジェクトが見つかりません' });
      return;
    }

    if (baseVersion !== undefined && baseVersion < room.version - MAX_OPS_LOG) {
      if (typeof ack === 'function') {
        ack({ error: 'version_too_old', needFullSync: true, version: room.version });
      }
      socket.emit('full_sync_required', { version: room.version, snapshot: room.snapshot });
      return;
    }

    // Phase 3: 競合検出 — 同じタスクに対する同時操作をチェック
    const opTaskId = op.payload?.taskId || op.payload?.taskId || op.taskId;
    if (opTaskId && op.type !== 'state_sync' && op.type !== 'task_add' && op.type !== 'dep_add') {
      const existingLock = room.taskLocks.get(opTaskId);
      if (existingLock && existingLock.socketId !== socket.id) {
        // 別のユーザーが同じタスクを編集中 — 競合通知を送信
        const conflictUser = existingLock.displayName || '他のユーザー';
        socket.emit('conflict_detected', {
          taskId: opTaskId,
          conflictUser: conflictUser,
          opType: op.type,
          ts: Date.now(),
        });
        // LWW: 最後に到着した操作で上書き（処理は続行）
        console.log(`[conflict] task:${opTaskId} user:${currentUserId} vs ${conflictUser} (LWW)`);
      }
    }

    room.version += 1;
    const serverVersion = room.version;

    // 表示名を取得（room.clientsから取得→次にcurrentUserInfo→次に_effectiveDisplayName）
    const clientInfo = room.clients.get(socket.id);
    const opDisplayName = (clientInfo && clientInfo.displayName)
      || (currentUserInfo && currentUserInfo.displayName)
      || _effectiveDisplayName
      || null;

    const serverOp = {
      ...op,
      version:   serverVersion,
      userId:    currentUserId,
      displayName: opDisplayName,  // Phase 2-A/3
      socketId:  socket.id,
      sessionId: sessionId || null,
      ts:        Date.now(),
    };

    appendOp(room, serverOp);
    socket.to(projectId).emit('op_broadcast', serverOp);

    // Phase 2-C: 操作ログをDBに保存
    saveOpLog(projectId, serverOp, serverVersion);

    console.log(`[op] ${op.type} v${serverVersion} project:${projectId} user:${currentUserId || socket.id}`);
    if (typeof ack === 'function') ack({ ok: true, version: serverVersion });
  });

  // ── snapshot_update ───────────────────────────────────
  socket.on('snapshot_update', async (data, ack) => {
    const { projectId, snapshot, version } = data || {};
    if (!projectId || !snapshot) {
      if (typeof ack === 'function') ack({ error: 'projectId と snapshot は必須です' });
      return;
    }

    const room = rooms.get(projectId);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'プロジェクトが見つかりません' });
      return;
    }

    // バージョンチェック: 送信側の version がサーバーの version 以上の場合のみ更新
    // ただし version が未定義の場合や、スナップショットがまだない場合は必ず保存
    const shouldUpdate = version === undefined
      || version >= room.version
      || room.snapshot === null;  // スナップショットがない場合は必ず保存

    if (shouldUpdate) {
      room.snapshot = snapshot;
      if (version !== undefined) {
        room.version = Math.max(room.version, version);
        room.snapshotVersion = version;
      } else {
        room.snapshotVersion = room.version;
      }
      console.log(`[snapshot] updated project:${projectId} v${room.version}`);
    } else {
      console.log(`[snapshot] skipped project:${projectId} sent-v${version} room-v${room.version}`);
    }

    scheduleSaveToDb(projectId, room.snapshot, room.version);
    if (typeof ack === 'function') ack({ ok: true, version: room.version });
  });

  // ── request_full_sync ────────────────────────────────
  socket.on('request_full_sync', async (data) => {
    const { projectId } = data || {};
    const room = projectId && rooms.get(projectId);
    if (!room) return;

    if (!room.dbLoaded) {
      const dbData = await loadFromDb(projectId);
      room.snapshot = dbData.snapshot;
      room.version  = dbData.version;
      room.snapshotVersion = dbData.version;
      room.dbLoaded = true;
    }

    socket.emit('full_sync', { version: room.version, snapshot: room.snapshot });
  });

  // ── cursor_move ──────────────────────────────────────
  socket.on('cursor_move', (data) => {
    const { projectId, x, y, rowId, dayIndex } = data || {};
    if (!projectId) return;
    socket.to(projectId).emit('cursor_update', {
      socketId: socket.id, userId: currentUserId, x, y, rowId, dayIndex,
    });
  });

  // ── task_select（タスク選択同期・Phase 4） ──────────
  socket.on('task_select', (data) => {
    const { projectId, taskIds, dependencyIds, annotationIds } = data || {};
    if (!projectId) return;
    const room = rooms.get(projectId);
    if (!room) return;
    const clientInfo = room.clients.get(socket.id);
    if (!clientInfo) return;
    // 他のクライアントに選択状態を通知（タスク＋依存線＋アノテーション）
    socket.to(projectId).emit('remote_select', {
      socketId: socket.id,
      userId: currentUserId,
      displayName: clientInfo.displayName || _effectiveDisplayName || '他のユーザー',
      color: clientInfo.color || '#888',
      taskIds: taskIds || [],
      dependencyIds: dependencyIds || [],
      annotationIds: annotationIds || [],
      ts: Date.now(),
    });
  });

  // ── task_lock（編集ロック取得） ────────────────────
  socket.on('task_lock', (data, ack) => {
    const { projectId, taskId } = data || {};
    console.log(`[lock] request task:${taskId} from socket:${socket.id} user:${currentUserId}`);
    if (!projectId || !taskId) {
      if (typeof ack === 'function') ack({ error: 'projectId と taskId は必須です' });
      return;
    }
    const room = rooms.get(projectId);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'プロジェクトが見つかりません' });
      return;
    }
    // 既にロックされているか確認
    const existing = room.taskLocks.get(taskId);
    if (existing && existing.socketId !== socket.id) {
      console.log(`[lock] DENIED task:${taskId} user:${currentUserId} — already locked by ${existing.userId}`);
      if (typeof ack === 'function') ack({
        locked: true,
        lockedBy: existing.displayName || '他のユーザー',
      });
      return;
    }
    // ロック取得
    const lockClientInfo = room.clients.get(socket.id);
    room.taskLocks.set(taskId, {
      socketId: socket.id,
      userId: currentUserId,
      displayName: (lockClientInfo && lockClientInfo.displayName)
        || (currentUserInfo && currentUserInfo.displayName)
        || _effectiveDisplayName
        || '他のユーザー',
      ts: Date.now(),
    });
    console.log(`[lock] acquired task:${taskId} by user:${currentUserId} (locks:${room.taskLocks.size})`);
    // 他のクライアントにロック状態を通知
    const lockColor = (lockClientInfo && lockClientInfo.color) || '#888';
    socket.to(projectId).emit('task_locked', {
      taskId: taskId,
      lockedBy: (lockClientInfo && lockClientInfo.displayName)
        || (currentUserInfo && currentUserInfo.displayName)
        || _effectiveDisplayName
        || '他のユーザー',
      color: lockColor,
      ts: Date.now(),
    });
    if (typeof ack === 'function') ack({ locked: false, ok: true });
  });

  // ── task_unlock（編集ロック解放） ──────────────────
  socket.on('task_unlock', (data) => {
    const { projectId, taskId } = data || {};
    if (!projectId || !taskId) return;
    console.log(`[unlock] request task:${taskId} from socket:${socket.id} user:${currentUserId}`);
    const room = rooms.get(projectId);
    if (!room) return;
    // 自分のロックのみ解放
    const existing = room.taskLocks.get(taskId);
    if (existing && existing.socketId === socket.id) {
      room.taskLocks.delete(taskId);
      socket.to(projectId).emit('task_unlocked', { taskId, ts: Date.now() });
    }
  });

  // ── dep_lock（依存線編集ロック取得）Phase 4-B ──────────
  socket.on('dep_lock', (data, ack) => {
    const { projectId, depId } = data || {};
    if (!projectId || !depId) { if (typeof ack === 'function') ack({ error: 'projectId と depId は必須です' }); return; }
    const room = rooms.get(projectId);
    if (!room) { if (typeof ack === 'function') ack({ error: 'プロジェクトが見つかりません' }); return; }
    const existing = room.depLocks.get(depId);
    if (existing && existing.socketId !== socket.id) {
      if (typeof ack === 'function') ack({ locked: true, lockedBy: existing.displayName || '他のユーザー' });
      return;
    }
    const lockClientInfo = room.clients.get(socket.id);
    room.depLocks.set(depId, {
      socketId: socket.id, userId: currentUserId,
      displayName: (lockClientInfo && lockClientInfo.displayName) || _effectiveDisplayName || '他のユーザー',
      ts: Date.now(),
    });
    const lockColor = (lockClientInfo && lockClientInfo.color) || '#888';
    socket.to(projectId).emit('dep_locked', { depId, lockedBy: (lockClientInfo && lockClientInfo.displayName) || _effectiveDisplayName || '他のユーザー', color: lockColor, ts: Date.now() });
    if (typeof ack === 'function') ack({ locked: false, ok: true });
  });

  // ── dep_unlock（依存線編集ロック解放）Phase 4-B ────────
  socket.on('dep_unlock', (data) => {
    const { projectId, depId } = data || {};
    if (!projectId || !depId) return;
    const room = rooms.get(projectId);
    if (!room) return;
    const existing = room.depLocks.get(depId);
    if (existing && existing.socketId === socket.id) {
      room.depLocks.delete(depId);
      socket.to(projectId).emit('dep_unlocked', { depId, ts: Date.now() });
    }
  });

  // ── ann_lock（注記編集ロック取得）Phase 4-C ──────────
  socket.on('ann_lock', (data, ack) => {
    const { projectId, annId } = data || {};
    if (!projectId || !annId) { if (typeof ack === 'function') ack({ error: 'projectId と annId は必須です' }); return; }
    const room = rooms.get(projectId);
    if (!room) { if (typeof ack === 'function') ack({ error: 'プロジェクトが見つかりません' }); return; }
    const existing = room.annLocks.get(annId);
    if (existing && existing.socketId !== socket.id) {
      if (typeof ack === 'function') ack({ locked: true, lockedBy: existing.displayName || '他のユーザー' });
      return;
    }
    const lockClientInfo = room.clients.get(socket.id);
    room.annLocks.set(annId, {
      socketId: socket.id, userId: currentUserId,
      displayName: (lockClientInfo && lockClientInfo.displayName) || _effectiveDisplayName || '他のユーザー',
      ts: Date.now(),
    });
    const lockColor = (lockClientInfo && lockClientInfo.color) || '#888';
    socket.to(projectId).emit('ann_locked', { annId, lockedBy: (lockClientInfo && lockClientInfo.displayName) || _effectiveDisplayName || '他のユーザー', color: lockColor, ts: Date.now() });
    if (typeof ack === 'function') ack({ locked: false, ok: true });
  });

  // ── ann_unlock（注記編集ロック解放）Phase 4-C ────────
  socket.on('ann_unlock', (data) => {
    const { projectId, annId } = data || {};
    if (!projectId || !annId) return;
    const room = rooms.get(projectId);
    if (!room) return;
    const existing = room.annLocks.get(annId);
    if (existing && existing.socketId === socket.id) {
      room.annLocks.delete(annId);
      socket.to(projectId).emit('ann_unlocked', { annId, ts: Date.now() });
    }
  });

  // ── Phase 5-1: 通知プッシュ ─────────────────────────
  // サーバーサイド(PHP/cron)からのWebSocket通知プッシュ用
  // 使用法: socket.emit('push_notification', { target_user_ids: [1,2], notification: {...} })
  // ※ 管理者ソケットのみ許可
  socket.on('push_notification', (data) => {
    const authUser = socket._ganttAuthUser;
    if (!authUser || authUser.role !== 'admin') return; // 管理者のみ
    const { target_user_ids, notification } = data || {};
    if (!notification || !Array.isArray(target_user_ids)) return;
    // 全ルームを走査して対象ユーザーのソケットへ通知
    for (const [projId, room] of rooms) {
      for (const [sockId, clientInfo] of room.clients) {
        // dbUserId(数値) で照合
        if (clientInfo.dbUserId && target_user_ids.includes(clientInfo.dbUserId)) {
          io.to(sockId).emit('notification_received', notification);
        }
      }
    }
  });

  // ── disconnect ──────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
    if (currentProjectId) leaveRoom(socket, currentProjectId);
  });

  function leaveRoom(sock, projectId) {
    const room = rooms.get(projectId);
    if (!room) return;
    // 離脱するユーザー情報を取得（通知用）
    const leavingUser = room.clients.get(sock.id);
    const leavingName = leavingUser ? leavingUser.displayName : null;
    // Phase 3: 離脱ユーザーのタスクロックを全て解放
    for (const [taskId, lockInfo] of room.taskLocks) {
      if (lockInfo.socketId === sock.id) {
        room.taskLocks.delete(taskId);
        io.to(projectId).emit('task_unlocked', { taskId, ts: Date.now() });
      }
    }
    // Phase 4-B: 離脱ユーザーの依存線ロックを全て解放
    for (const [depId, lockInfo] of room.depLocks) {
      if (lockInfo.socketId === sock.id) {
        room.depLocks.delete(depId);
        io.to(projectId).emit('dep_unlocked', { depId, ts: Date.now() });
      }
    }
    // Phase 4-C: 離脱ユーザーの注記ロックを全て解放
    for (const [annId, lockInfo] of room.annLocks) {
      if (lockInfo.socketId === sock.id) {
        room.annLocks.delete(annId);
        io.to(projectId).emit('ann_unlocked', { annId, ts: Date.now() });
      }
    }
    room.clients.delete(sock.id);
    sock.leave(projectId);
    broadcastPresence(projectId);

    // Phase 2-C: ユーザー離脱通知（残っているユーザーに送信）
    if (leavingName && room.clients.size > 0) {
      io.to(projectId).emit('user_leave', {
        displayName: leavingName,
        socketId: sock.id,
        ts: Date.now(),
      });
    }

    if (room.clients.size === 0 && room.snapshot) {
      saveToDbNow(projectId, room.snapshot, room.version);
      console.log(`[DB] final save on room empty project:${projectId} v${room.version}`);
      rooms.delete(projectId);
    }

    console.log(`[leave] ${sock.id} ← room:${projectId} (残り${room.clients.size}人)`);
  }
});

// ─── サーバー起動 ────────────────────────────────────────
async function start() {
  await testDbConnection();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`  ガントチャート WebSocket サーバー起動 (Phase 3)`);
    console.log(`  ポート : ${PORT}`);
    console.log(`  モード : HTTP + MySQL + 認証`);
    console.log(`  時刻   : ${new Date().toLocaleString('ja-JP')}`);
    console.log(`====================================================`);
  });
}

start();

process.on('uncaughtException',  (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
