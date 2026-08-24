/**
 * WebGantt Teams Excel Importer — ポップアップ本体処理
 * 参照: docs/teams-excel-import-design.md 7.2節・7.3節・8.3節・18節（複数フォーマット対応）
 *
 * 処理フロー（設計書8.3節）:
 *  1. storageからトークン読込。未設定なら設定画面への導線を表示
 *  2. list_projects でプロジェクト一覧取得
 *  3. ポップアップを開いたタイミングで自動的にExcel取得処理を実行する（新規要望）。
 *     「再取得」ボタンは、SharePointへの再ログイン後やExcel更新直後の
 *     手動リトライ用として残す:
 *     a. SharePoint currentuser API で疎通確認
 *     b. shares API で downloadUrl を取得
 *     c. downloadUrl から Excel実体(ArrayBuffer)を取得
 *     d. XLSX.read() でパース、設定済みフォーマット（WGT.getFormat(formatId)）の
 *        listWeeks/extractTasks で週・予定を抽出（18節、フォーマット非依存化）
 *     e. 週チェックボックス・予定チェックボックスUIを表示（新規要望1）
 *  4. 「インポート実行」ボタン: チェック済み予定 + 選択中プロジェクトIDをサーバーへPOST
 *
 * 【2026-08-24追記】複数フォーマット対応。従来この中に直接埋め込まれていた
 * 「週間予定表」専用の解析ロジック呼び出し（WGT.detectWeekBlocks等）を、
 * 設定画面（options.html）で選択したフォーマットID（wgtFormatId、未設定時は
 * WGT.DEFAULT_FORMAT_ID='weekly-table'にフォールバック）に対応する
 * フォーマットオブジェクト（WGT.getFormat(id)）経由の呼び出しに変更した。
 * ポップアップの画面構成・操作フロー自体は一切変更していない。
 */

const SERVER_BASE = 'https://ogma.mydns.jp/WebGantt';
const API_ENDPOINT = SERVER_BASE + '/api/teams_excel_import.php';

let state = {
  token: null,
  shareUrl: null,
  formatId: null,      // 設定画面で選択済みのフォーマットID（未設定時はWGT.DEFAULT_FORMAT_IDにフォールバック）
  format: null,         // WGT.getFormat(formatId) の結果をキャッシュ（{ id, label, listWeeks, extractTasks }）
  projects: [],       // [{ projectId, name, members: [displayName,...] }]
  workbook: null,      // XLSX.read() の結果（再利用のためキャッシュ）
  weeks: [],           // [{ index, startDate, endDate, checked }] ※日付昇順(古い→新しい)で保持
  tasks: [],           // [{ assignee, taskName, startDate, endDate, checked }]
  taskFilter: '',      // ③タスク一覧の名前フィルタ文字列（担当者名・作業名の両方を対象）
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  document.getElementById('openOptionsLink').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  // ヘッダー右上の常時表示「⚙」設定ボタン（トークン設定状態に関わらず常に表示。
  // 初回設定を間違えた場合でも設定画面へ迷わず戻れるようにするための導線。2026-08-23追加）
  document.getElementById('openOptionsBtn').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  // Manifest V3のCSPによりHTML側のinline onclick属性は使用できないため、
  // ここでイベントリスナーを登録する（設計書8.3節）
  document.getElementById('fetchBtn').addEventListener('click', onFetchClick);
  document.getElementById('selectAllLink').addEventListener('click', function () { setAllChecks(true); });
  document.getElementById('deselectAllLink').addEventListener('click', function () { setAllChecks(false); });
  document.getElementById('importBtn').addEventListener('click', onImportClick);
  document.getElementById('taskFilterInput').addEventListener('input', function (e) {
    state.taskFilter = e.target.value;
    renderTaskList();
  });
  // 名称クイック選択ドロップダウン（新規要望2）：選択するとフィルタ入力欄に反映される
  document.getElementById('taskFilterNameSelect').addEventListener('change', function (e) {
    state.taskFilter = e.target.value;
    document.getElementById('taskFilterInput').value = e.target.value;
    renderTaskList();
  });

  const stored = await chromeStorageGet(['wgtToken', 'wgtShareUrl', 'wgtFormatId']);
  if (!stored.wgtToken) {
    document.getElementById('noTokenNotice').style.display = 'block';
    document.getElementById('mainUi').style.display = 'none';
    return;
  }
  state.token = stored.wgtToken;
  state.shareUrl = stored.wgtShareUrl || '';
  // フォーマット未設定（拡張機能アップデート直後で旧バージョンから引き継いだ場合など）は
  // 従来唯一のフォーマットだった weekly-table にフォールバックし、既存ユーザーの動作を維持する
  state.formatId = stored.wgtFormatId || WGT.DEFAULT_FORMAT_ID;
  state.format = WGT.getFormat(state.formatId);
  if (!state.format) {
    showMsg('設定されているフォーマット（' + state.formatId + '）が見つかりません。設定画面で選び直してください', 'error');
    document.getElementById('mainUi').style.display = 'none';
    return;
  }

  document.getElementById('noTokenNotice').style.display = 'none';
  document.getElementById('mainUi').style.display = 'block';

  await loadProjects();

  // ポップアップを開いたタイミングで自動的にExcel取得を行う（新規要望）。
  // 共有リンクが未設定の場合はonFetchClick側で分かりやすいエラーメッセージが出るため、
  // ここでは特に分岐せずそのまま呼び出す。
  if (state.shareUrl) {
    await onFetchClick();
  }
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
    const siteBase = WGT.extractSiteBaseUrl(state.shareUrl);
    const meRes = await fetch(siteBase + '/_api/web/currentuser', {
      headers: { Accept: 'application/json;odata=nometadata' },
      credentials: 'include',
    });
    if (!meRes.ok) {
      throw new Error('SharePointにログインしていないようです。ブラウザでTeams/SharePointに一度ログインしてから再実行してください（status: ' + meRes.status + '）');
    }

    // b. shares API で downloadUrl 取得
    const tenantOrigin = new URL(state.shareUrl).origin;
    const encodedShareId = WGT.encodeSharingUrl(state.shareUrl);
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

    // 週一覧のみ先に検出してチェックボックスを表示（設定済みフォーマットのlistWeeksを使用。18節）
    console.log('[WGT debug] シート一覧:', JSON.stringify(workbook.SheetNames));
    console.log('[WGT debug] 使用フォーマット:', state.formatId);
    const weekSummaries = state.format.listWeeks(workbook);
    console.log('[WGT debug] 検出された週数:', weekSummaries.length);
    console.log('[WGT debug] 検出された週詳細(JSON):', JSON.stringify(weekSummaries));
    if (weekSummaries.length === 0) {
      console.log('[WGT debug] 週が検出できませんでした。設定画面で選択中のフォーマット（' + state.formatId + '）と、実際のExcelファイルのフォーマットが一致しているかご確認ください。');
    }

    // state.weeks は日付昇順（古い→新しい）のまま保持する。
    // index は state.format.extractTasks() の selectedWeekIndexes と対応させるため、
    // weekSummaries配列の並び順のまま採番する（表示順序はrenderWeekList側で逆順にする）。
    // デフォルトのチェック状態は「最新の1週間のみON」とする（新規要望）。
    const lastIdx = weekSummaries.length - 1;
    state.weeks = weekSummaries.map(function (w, idx) {
      return {
        index: idx,
        startDate: w.startDate,
        endDate: w.endDate,
        checked: idx === lastIdx, // 最新週（配列末尾＝日付が最も新しい週）のみデフォルトON
      };
    });

    renderWeekList();
    recomputeTasks();
    if (weekSummaries.length === 0) {
      showMsg('Excelは取得できましたが、週を検出できませんでした。設定画面で選択中のフォーマットが正しいかご確認ください。詳細はポップアップを右クリック→「検証」→Consoleタブをご確認ください', 'error');
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

// extractSiteBaseUrl / encodeSharingUrl は common.js（WGT名前空間）に移設済み
// （2026-08-23、options.js保存時接続テストとの共通化のため。WGT.extractSiteBaseUrl /
//  WGT.encodeSharingUrl を参照）

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
  // state.weeks自体は日付昇順(古い→新しい)を保持したまま、表示のみ新しい週が
  // 上に来るよう逆順にする（新規要望）。indexプロパティで元のブロックと
  // 対応しているため、並び替えは表示用コピーに対してのみ行う。
  const displayWeeks = state.weeks.slice().reverse();
  displayWeeks.forEach(function (w) {
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
  if (!state.workbook || !state.format) return;
  const selectedIdx = state.weeks.filter(function (w) { return w.checked; }).map(function (w) { return w.index; });
  const extracted = state.format.extractTasks(state.workbook, { selectedWeekIndexes: selectedIdx });

  const members = getCurrentMembers();
  state.tasks = extracted.tasks.map(function (t) {
    return {
      assignee: WGT.matchAssigneeToMember(t.assignee, members), // 8.4節 苗字部分一致マッチング
      taskName: t.taskName,
      startDate: t.startDate,
      endDate: t.endDate,
      checked: false, // デフォルトは非選択（新規要望：ユーザーが個別に選ぶ方式）
    };
  });

  updateTaskFilterNameOptions();
  renderTaskList();
}

/**
 * 名称クイック選択ドロップダウン（新規要望2）の選択肢を、現在の
 * state.tasks に含まれる担当者名・作業名のユニーク一覧で更新する。
 * フィルタ欄への手入力が面倒なユーザー向けに、既知の名称をクリックで
 * 選べるようにするための機能。現在選択中の値は可能な範囲で維持する。
 */
function updateTaskFilterNameOptions() {
  const select = document.getElementById('taskFilterNameSelect');
  if (!select) return;
  const currentValue = select.value;

  const names = new Set();
  state.tasks.forEach(function (t) {
    if (t.assignee) names.add(t.assignee);
    if (t.taskName) names.add(t.taskName);
  });
  const sortedNames = Array.from(names).sort(function (a, b) {
    return a.localeCompare(b, 'ja');
  });

  select.innerHTML = '';
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '(名称を選択)';
  select.appendChild(emptyOpt);
  sortedNames.forEach(function (name) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });

  // 直前の選択値が新しい一覧にも存在すれば維持する
  if (sortedNames.indexOf(currentValue) !== -1) {
    select.value = currentValue;
  } else {
    select.value = '';
  }
}

/**
 * 現在の名前フィルタ文字列(state.taskFilter)にマッチするタスクの
 * (元のstate.tasks配列上の)インデックス一覧を返す。
 * 作業名(taskName)・担当者名(assignee)のどちらかに部分一致すれば対象とする。
 * フィルタが空文字の場合は全件を返す。
 */
function getFilteredTaskIndexes() {
  const keyword = (state.taskFilter || '').trim().toLowerCase();
  const indexes = [];
  state.tasks.forEach(function (t, idx) {
    if (keyword === '') {
      indexes.push(idx);
      return;
    }
    const taskName = (t.taskName || '').toLowerCase();
    const assignee = (t.assignee || '').toLowerCase();
    if (taskName.indexOf(keyword) !== -1 || assignee.indexOf(keyword) !== -1) {
      indexes.push(idx);
    }
  });
  return indexes;
}

function renderTaskList() {
  const section = document.getElementById('taskSection');
  const container = document.getElementById('taskList');
  const filterRow = document.getElementById('taskFilterRow');
  const countEl = document.getElementById('taskCount');
  container.innerHTML = '';

  if (state.tasks.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  if (filterRow) filterRow.style.display = 'flex';

  const filteredIndexes = getFilteredTaskIndexes();

  if (countEl) {
    const checkedCount = state.tasks.filter(function (t) { return t.checked; }).length;
    countEl.textContent = '表示 ' + filteredIndexes.length + ' / 全 ' + state.tasks.length + ' 件（選択中 ' + checkedCount + ' 件）';
  }

  if (filteredIndexes.length === 0) {
    container.innerHTML = '<div style="font-size:11px;color:#8a93a3;padding:6px 0;">条件に一致する予定がありません</div>';
    return;
  }

  filteredIndexes.forEach(function (idx) {
    const t = state.tasks[idx];
    const item = document.createElement('div');
    item.className = 'task-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = t.checked;
    cb.addEventListener('change', function () {
      state.tasks[idx].checked = cb.checked;
      updateTaskCountOnly();
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

/** チェック操作のたびにリスト全体を再描画すると重いため、件数表示だけ更新する軽量版 */
function updateTaskCountOnly() {
  const countEl = document.getElementById('taskCount');
  if (!countEl) return;
  const filteredIndexes = getFilteredTaskIndexes();
  const checkedCount = state.tasks.filter(function (t) { return t.checked; }).length;
  countEl.textContent = '表示 ' + filteredIndexes.length + ' / 全 ' + state.tasks.length + ' 件（選択中 ' + checkedCount + ' 件）';
}

/** 全選択・全解除は「現在フィルタで表示されている行」のみを対象にする（新規要望・名前フィルタとの併用を考慮） */
function setAllChecks(value) {
  const filteredIndexes = getFilteredTaskIndexes();
  filteredIndexes.forEach(function (idx) { state.tasks[idx].checked = value; });
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
