/**
 * WebGantt Teams Excel Importer — ポップアップ本体処理
 * 参照: docs/teams-excel-import-design.md 7.2節・7.3節・8.3節
 *
 * 処理フロー（設計書8.3節）:
 *  1. storageからトークン読込。未設定なら設定画面への導線を表示
 *  2. list_projects でプロジェクト一覧取得
 *  3. 「Excelを取得」ボタン:
 *     a. SharePoint currentuser API で疎通確認
 *     b. shares API で downloadUrl を取得
 *     c. downloadUrl から Excel実体(ArrayBuffer)を取得
 *     d. XLSX.read() でパース、common.js の WGT.* で週ブロック・予定を抽出
 *     e. 週チェックボックス・予定チェックボックスUIを表示（新規要望1）
 *  4. 「インポート実行」ボタン: チェック済み予定 + 選択中プロジェクトIDをサーバーへPOST
 */

const SERVER_BASE = 'https://ogma.mydns.jp/WebGantt';
const API_ENDPOINT = SERVER_BASE + '/api/teams_excel_import.php';

let state = {
  token: null,
  shareUrl: null,
  projects: [],       // [{ projectId, name, members: [displayName,...] }]
  workbook: null,      // XLSX.read() の結果（再利用のためキャッシュ）
  weeks: [],           // [{ index, startDate, endDate, checked }]
  tasks: [],           // [{ assignee, taskName, startDate, endDate, checked }]
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  document.getElementById('openOptionsLink').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Manifest V3のCSPによりHTML側のinline onclick属性は使用できないため、
  // ここでイベントリスナーを登録する（設計書8.3節）
  document.getElementById('fetchBtn').addEventListener('click', onFetchClick);
  document.getElementById('selectAllLink').addEventListener('click', function () { setAllChecks(true); });
  document.getElementById('deselectAllLink').addEventListener('click', function () { setAllChecks(false); });
  document.getElementById('importBtn').addEventListener('click', onImportClick);

  const stored = await chromeStorageGet(['wgtToken', 'wgtShareUrl']);
  if (!stored.wgtToken) {
    document.getElementById('noTokenNotice').style.display = 'block';
    document.getElementById('mainUi').style.display = 'none';
    return;
  }
  state.token = stored.wgtToken;
  state.shareUrl = stored.wgtShareUrl || '';

  document.getElementById('noTokenNotice').style.display = 'none';
  document.getElementById('mainUi').style.display = 'block';

  await loadProjects();
}

function chromeStorageGet(keys) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(keys, resolve);
  });
}

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'message ' + (type || 'info');
}

function clearMsg() {
  const el = document.getElementById('msg');
  el.textContent = '';
  el.className = 'message';
}

// ─────────────────────────────────────────────────────────
// プロジェクト一覧取得
// ─────────────────────────────────────────────────────────

async function loadProjects() {
  try {
    const res = await fetch(API_ENDPOINT + '?action=list_projects', {
      headers: { Authorization: 'Bearer ' + state.token },
    });
    const data = await res.json();
    if (data.error) {
      showMsg('プロジェクト一覧の取得に失敗しました: ' + data.error, 'error');
      return;
    }
    state.projects = data.projects || [];
    const sel = document.getElementById('projectSelect');
    sel.innerHTML = '';
    if (state.projects.length === 0) {
      sel.innerHTML = '<option value="">(アクセス可能なプロジェクトがありません)</option>';
      return;
    }
    state.projects.forEach(function (p) {
      const opt = document.createElement('option');
      opt.value = p.projectId;
      opt.textContent = p.name;
      sel.appendChild(opt);
    });
  } catch (err) {
    showMsg('プロジェクト一覧の取得に失敗しました（通信エラー）: ' + err.message, 'error');
  }
}

function getCurrentMembers() {
  const projectId = document.getElementById('projectSelect').value;
  const p = state.projects.find(function (x) { return x.projectId === projectId; });
  return p ? (p.members || []) : [];
}

// ─────────────────────────────────────────────────────────
// 「Excelを取得」ボタン
// ─────────────────────────────────────────────────────────

async function onFetchClick() {
  if (!state.shareUrl) {
    showMsg('共有リンクが未設定です。設定画面から登録してください', 'error');
    return;
  }
  clearMsg();
  setBusy(true, 'Excelを取得しています...');

  try {
    // a. SharePoint 疎通確認
    const siteBase = extractSiteBaseUrl(state.shareUrl);
    const meRes = await fetch(siteBase + '/_api/web/currentuser', {
      headers: { Accept: 'application/json;odata=nometadata' },
      credentials: 'include',
    });
    if (!meRes.ok) {
      throw new Error('SharePointにログインしていないようです。ブラウザでTeams/SharePointに一度ログインしてから再実行してください（status: ' + meRes.status + '）');
    }

    // b. shares API で downloadUrl 取得
    const tenantOrigin = new URL(state.shareUrl).origin;
    const encodedShareId = encodeSharingUrl(state.shareUrl);
    const sharesRes = await fetch(tenantOrigin + '/_api/v2.0/shares/' + encodedShareId + '/driveItem', {
      headers: { Accept: 'application/json;odata=nometadata' },
      credentials: 'include',
    });
    if (!sharesRes.ok) {
      throw new Error('Excelファイル情報の取得に失敗しました（status: ' + sharesRes.status + '）。共有リンクが正しいか確認してください');
    }
    const sharesData = await sharesRes.json();
    const downloadUrl = sharesData['@content.downloadUrl'] || sharesData['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error('ダウンロードURLが取得できませんでした（レスポンス形式が想定と異なります）');
    }

    // c. Excel実体取得
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) {
      throw new Error('Excelファイル本体のダウンロードに失敗しました（status: ' + fileRes.status + '）');
    }
    const arrayBuffer = await fileRes.arrayBuffer();

    // d. パース
    const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
    state.workbook = workbook;

    // 週ブロックのみ先に検出してチェックボックスを表示
    const pickedSheetName = WGT.pickDefaultSheet(workbook);
    const sheet = workbook.Sheets[pickedSheetName];
    const blocks = WGT.detectWeekBlocks(sheet);

    // デバッグ用ログ（週ブロックが検出できない場合の原因調査用。
    // ポップアップを右クリック→「検証」→Consoleタブで確認できる）
    console.log('[WGT debug] シート一覧:', workbook.SheetNames);
    console.log('[WGT debug] 選択されたシート名:', pickedSheetName);
    console.log('[WGT debug] シート範囲(!ref):', sheet && sheet['!ref']);
    console.log('[WGT debug] 検出された週ブロック数:', blocks.length, blocks);
    if (blocks.length === 0 && sheet && sheet['!ref']) {
      const dbgRange = XLSX.utils.decode_range(sheet['!ref']);
      const aColDump = [];
      for (let r = dbgRange.s.r; r <= Math.min(dbgRange.e.r, dbgRange.s.r + 60); r++) {
        const ref = XLSX.utils.encode_cell({ r, c: dbgRange.s.c });
        const cell = sheet[ref];
        aColDump.push({ row: r, value: cell ? cell.v : null, type: cell ? cell.t : null });
      }
      console.log('[WGT debug] A列(先頭列)の内容ダンプ(先頭60行):', aColDump);
    }

    state.weeks = blocks.map(function (b, idx) {
      return {
        index: idx,
        startDate: b.dateColumns[0].date,
        endDate: b.dateColumns[b.dateColumns.length - 1].date,
        checked: true,
      };
    });

    renderWeekList();
    recomputeTasks();
    if (blocks.length === 0) {
      showMsg('Excelは取得できましたが、週ブロックを検出できませんでした。詳細はポップアップを右クリック→「検証」→Consoleタブをご確認ください', 'error');
    } else {
      showMsg('Excelを取得しました。取り込む週・予定を選択してください', 'success');
    }
  } catch (err) {
    console.error(err);
    showMsg('取得に失敗しました: ' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}

/** 共有URLから、Cookie認証チェック(currentuser API)に使うサイト基点URLを推測する。
 * 例: https://suzumond.sharepoint.com/:x:/s/msteams_b3d137/xxxxx
 *  → https://suzumond.sharepoint.com/sites/msteams_b3d137 相当のURLパターンを推測
 * パターンに一致しない場合はオリジンのみを返す(この場合 currentuser が404になる可能性あり、
 * その際はエラーメッセージでユーザーに共有リンクの確認を促す)。
 */
function extractSiteBaseUrl(shareUrl) {
  try {
    const u = new URL(shareUrl);
    const m = u.pathname.match(/\/(?:personal|sites|teams)\/([^/]+)/i);
    if (m) {
      // OneDrive個人サイト(/personal/xxx)、チームサイト(/sites/xxx)、Teamsサイト(/teams/xxx)いずれも
      // 直下のセグメントをそのままサイトパスとして採用する
      const kind = u.pathname.toLowerCase().indexOf('/personal/') !== -1 ? 'personal'
        : u.pathname.toLowerCase().indexOf('/teams/') !== -1 ? 'teams' : 'sites';
      return u.origin + '/' + kind + '/' + m[1];
    }
    return u.origin;
  } catch (e) {
    return '';
  }
}

/** Microsoft Graph/SharePoint sharesエンドポイント用の共有URLエンコード（"u!"プレフィックス方式） */
function encodeSharingUrl(sharingUrl) {
  const base64 = btoa(unescape(encodeURIComponent(sharingUrl)));
  const urlSafe = base64.replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');
  return 'u!' + urlSafe;
}

// ─────────────────────────────────────────────────────────
// 週チェックボックスUI
// ─────────────────────────────────────────────────────────

function renderWeekList() {
  const container = document.getElementById('weekList');
  container.innerHTML = '';
  if (state.weeks.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#dc2626;">週ブロックが検出できませんでした</div>';
    return;
  }
  state.weeks.forEach(function (w) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = w.checked;
    cb.addEventListener('change', function () {
      w.checked = cb.checked;
      recomputeTasks();
    });
    const span = document.createElement('span');
    span.textContent = w.startDate + ' 〜 ' + w.endDate;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });
}

// ─────────────────────────────────────────────────────────
// タスク抽出・チェックボックスUI
// ─────────────────────────────────────────────────────────

function recomputeTasks() {
  if (!state.workbook) return;
  const selectedIdx = state.weeks.filter(function (w) { return w.checked; }).map(function (w) { return w.index; });
  const extracted = WGT.extractTasksFromWorkbook(state.workbook, { selectedWeekIndexes: selectedIdx });

  const members = getCurrentMembers();
  state.tasks = extracted.tasks.map(function (t) {
    return {
      assignee: WGT.matchAssigneeToMember(t.assignee, members), // 8.4節 苗字部分一致マッチング
      taskName: t.taskName,
      startDate: t.startDate,
      endDate: t.endDate,
      checked: true,
    };
  });

  renderTaskList();
}

function renderTaskList() {
  const section = document.getElementById('taskSection');
  const container = document.getElementById('taskList');
  container.innerHTML = '';

  if (state.tasks.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  state.tasks.forEach(function (t, idx) {
    const item = document.createElement('div');
    item.className = 'task-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.checked;
    cb.addEventListener('change', function () {
      state.tasks[idx].checked = cb.checked;
    });

    const main = document.createElement('div');
    main.className = 'task-main';
    const nameEl = document.createElement('div');
    nameEl.className = 'task-name';
    nameEl.textContent = t.taskName;
    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta';
    const dateRange = t.startDate === t.endDate ? t.startDate : (t.startDate + ' 〜 ' + t.endDate);
    const assigneeText = t.assignee ? t.assignee : '(全体予定)';
    metaEl.textContent = dateRange + ' / ' + assigneeText;
    main.appendChild(nameEl);
    main.appendChild(metaEl);

    item.appendChild(cb);
    item.appendChild(main);
    container.appendChild(item);
  });
}

function setAllChecks(value) {
  state.tasks.forEach(function (t) { t.checked = value; });
  renderTaskList();
}

// ─────────────────────────────────────────────────────────
// 「インポート実行」ボタン
// ─────────────────────────────────────────────────────────

async function onImportClick() {
  const projectId = document.getElementById('projectSelect').value;
  if (!projectId) {
    showMsg('送信先プロジェクトを選択してください', 'error');
    return;
  }
  const selected = state.tasks.filter(function (t) { return t.checked; });
  if (selected.length === 0) {
    showMsg('取り込む予定を1件以上選択してください', 'error');
    return;
  }

  clearMsg();
  setBusy(true, 'インポート中...');

  try {
    const payload = {
      project_id: projectId,
      tasks: selected.map(function (t) {
        return {
          taskName: t.taskName,
          startDate: t.startDate,
          endDate: t.endDate,
          assignee: t.assignee,
        };
      }),
    };
    const res = await fetch(API_ENDPOINT + '?action=import_tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + state.token,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) {
      showMsg('インポートに失敗しました: ' + data.error, 'error');
      return;
    }
    showMsg(
      (data.importedCount || selected.length) + '件のタスクをインポートしました。\n' +
      'ガントチャート画面を開いている場合はリロードすると反映されます。',
      'success'
    );
  } catch (err) {
    showMsg('インポートに失敗しました（通信エラー）: ' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────
// UIビジー状態制御
// ─────────────────────────────────────────────────────────

function setBusy(busy, message) {
  document.getElementById('fetchBtn').disabled = busy;
  const importBtn = document.getElementById('importBtn');
  if (importBtn) importBtn.disabled = busy;
  if (busy && message) showMsg(message, 'info');
}
