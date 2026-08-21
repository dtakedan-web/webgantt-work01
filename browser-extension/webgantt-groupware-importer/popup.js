/**
 * WebGantt Groupware Importer — ポップアップ本体処理
 * 参照: docs/groupware-schedule-import-design.md 5節・6節・7節・8節・9節・10節
 *
 * 処理フロー:
 *  1. storageからトークン読込。未設定なら設定画面への導線を表示
 *  2. list_projects でプロジェクト一覧取得
 *  3. ポップアップを開いたタイミングで、デフォルト状態（基準週=今週、週数=1週）の
 *     まま自動的に取得処理を実行する（Teams Excel連携の「開いたら自動でExcelを
 *     取得する」挙動と揃える、新規要望・2026-08-21）。
 *     「取得」ボタンは、SSO再ログインが必要な場合や、基準週・週数を変更した
 *     後の手動リトライ用として残す:
 *     a. gwlogin へfetch（Windows統合認証によるSSO自動ログイン、5.2節）
 *     b. 基準週（デフォルト今週）から、選択された週数分だけ find_group_week を
 *        displayDateを+7日ずつ変えて複数回呼び出す（7節）
 *     c. 複数週分のschedulesを WGG.processSchedules() に渡し、
 *        ユニーク化・除外・連続日結合済みのタスク候補（EVENT/SCHEDULE）を得る
 *     d. チェックボックスUIを表示（初期状態は全て非選択、9節）
 *  4. 「インポート実行」ボタン: チェック済み予定 + 選択中プロジェクトIDをサーバーへPOST
 */

const SERVER_BASE = 'https://ogma.mydns.jp/WebGantt';
const API_ENDPOINT = SERVER_BASE + '/api/groupware_schedule_import.php';

const GWLOGIN_URL = 'http://suzumo.local/gwlogin';
const IMART_FIND_GROUP_WEEK_URL =
  'http://imap01.suzumo.local/imart/collaboration/schedule/user/calendar/find_group_week';

let state = {
  token: null,
  projects: [],        // [{ projectId, name, members: [displayName,...] }]
  baseWeekOffset: 0,    // 基準週の、今週からのオフセット（週単位。0=今週、-1=先週、+1=来週）
  weekCount: 1,         // 取得する週数（1〜4）
  tasks: [],            // [{ kind: 'event'|'meeting', assigneeCode, assigneeName, taskName, startDate, endDate, checked }]
  taskTypeFilter: 'all', // 'all' | 'event' | 'meeting'
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  document.getElementById('openOptionsLink').addEventListener('click', function (e) {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  document.getElementById('prevWeekBtn').addEventListener('click', function () {
    state.baseWeekOffset -= 1;
    renderBaseWeekLabel();
  });
  document.getElementById('nextWeekBtn').addEventListener('click', function () {
    state.baseWeekOffset += 1;
    renderBaseWeekLabel();
  });
  document.querySelectorAll('input[name="weekCount"]').forEach(function (radio) {
    radio.addEventListener('change', function (e) {
      state.weekCount = parseInt(e.target.value, 10) || 1;
      renderBaseWeekLabel();
    });
  });

  document.getElementById('fetchBtn').addEventListener('click', onFetchClick);
  document.getElementById('selectAllLink').addEventListener('click', function () { setAllChecks(true); });
  document.getElementById('deselectAllLink').addEventListener('click', function () { setAllChecks(false); });
  document.getElementById('importBtn').addEventListener('click', onImportClick);

  ['tabAll', 'tabEvent', 'tabMeeting'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function (e) {
      document.querySelectorAll('.type-tab').forEach(function (el) { el.classList.remove('active'); });
      e.target.classList.add('active');
      state.taskTypeFilter = e.target.getAttribute('data-type');
      renderTaskList();
    });
  });

  const stored = await chromeStorageGet(['wggToken']);
  if (!stored.wggToken) {
    document.getElementById('noTokenNotice').style.display = 'block';
    document.getElementById('mainUi').style.display = 'none';
    return;
  }
  state.token = stored.wggToken;

  document.getElementById('noTokenNotice').style.display = 'none';
  document.getElementById('mainUi').style.display = 'block';

  renderBaseWeekLabel();
  await loadProjects();

  // ポップアップを開いたタイミングで、デフォルト状態（今週・1週分）のまま
  // 自動的にスケジュール取得を行う（新規要望：Teams Excel連携と同じ挙動に統一）。
  // 取得できるプロジェクトが1つもない場合は自動取得しても意味がないためスキップする。
  if (state.projects.length > 0) {
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
// 週選択UI（7節: 基準週の前後移動 + 取得週数）
// ─────────────────────────────────────────────────────────

function renderBaseWeekLabel() {
  const baseSunday = WGG.getSundayOfWeek(new Date(), state.baseWeekOffset);
  const label = document.getElementById('baseWeekLabel');
  const isThisWeek = state.baseWeekOffset === 0;
  label.textContent = WGG.formatDisplaySlash(baseSunday) + '(日)を含む週' + (isThisWeek ? '（今週）' : '');

  // プレビュー: 実際にfind_group_weekへ渡すdisplayDateの範囲を表示
  const preview = [];
  for (let i = 0; i < state.weekCount; i++) {
    const sunday = new Date(baseSunday);
    sunday.setDate(sunday.getDate() + i * 7);
    const saturday = new Date(sunday);
    saturday.setDate(saturday.getDate() + 6);
    preview.push(WGG.formatDisplaySlash(sunday) + '〜' + WGG.formatDisplaySlash(saturday));
  }
  document.getElementById('weekRangePreview').textContent = '取得範囲: ' + preview.join(' / ');
}

// ─────────────────────────────────────────────────────────
// 「取得」ボタン: SSOログイン → find_group_week複数回呼び出し → 変換
// ─────────────────────────────────────────────────────────

async function onFetchClick() {
  clearMsg();
  setBusy(true, '社内グループウェアへログインしています...');

  try {
    // a. SSO自動ログイン（Windows統合認証、5.2節）
    const loginRes = await fetch(GWLOGIN_URL, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
    });
    if (!loginRes.ok) {
      throw new Error('社内グループウェアへのログインに失敗しました（status: ' + loginRes.status + '）。社内LANに接続されているか確認してください');
    }

    // b. 基準週から weekCount 分、displayDateを+7日ずつ変えて find_group_week を呼び出す（7節）
    setBusy(true, 'スケジュールを取得しています...');
    const baseSunday = WGG.getSundayOfWeek(new Date(), state.baseWeekOffset);
    const schedulesArraysList = [];

    for (let i = 0; i < state.weekCount; i++) {
      const targetSunday = new Date(baseSunday);
      targetSunday.setDate(targetSunday.getDate() + i * 7);
      const displayDate = WGG.formatYYYYMMDD(targetSunday);

      const body = 'view=groupWeek&displayDate=' + encodeURIComponent(displayDate) + '&target=&page=1';
      const res = await fetch(IMART_FIND_GROUP_WEEK_URL, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-jp-co-intra-mart-ajax-request-from-imui-form-util': 'true',
        },
        body: body,
      });
      if (!res.ok) {
        throw new Error('スケジュール取得に失敗しました（displayDate=' + displayDate + ', status: ' + res.status + '）');
      }
      const json = await res.json();
      if (json.error) {
        throw new Error('スケジュール取得APIがエラーを返しました（displayDate=' + displayDate + '）');
      }
      const schedulesArrays = (json.data && Array.isArray(json.data.schedules)) ? json.data.schedules : [];
      schedulesArraysList.push(schedulesArrays);
    }

    // c. ユニーク化・除外・連続日結合（8節）
    const { events, meetings } = WGG.processSchedules(schedulesArraysList);

    const members = getCurrentMembers();
    const eventTasks = events.map(function (t) {
      return {
        kind: 'event',
        assigneeCode: t.assigneeCode,
        assigneeName: WGG.matchAssigneeToMember(t.assigneeName, members),
        taskName: t.taskName,
        startDate: t.startDate,
        endDate: t.endDate,
        checked: false, // 9節: 初期状態は全て非選択
      };
    });
    const meetingTasks = meetings.map(function (t) {
      return {
        kind: 'meeting',
        assigneeCode: t.assigneeCode,
        assigneeName: WGG.matchAssigneeToMember(t.assigneeName, members),
        taskName: t.taskName,
        startDate: t.startDate,
        endDate: t.endDate,
        checked: false, // 8.5節: 会議もデフォルト非選択
      };
    });

    state.tasks = eventTasks.concat(meetingTasks);
    state.taskTypeFilter = 'all';
    document.querySelectorAll('.type-tab').forEach(function (el) { el.classList.remove('active'); });
    document.getElementById('tabAll').classList.add('active');

    renderTaskList();

    if (state.tasks.length === 0) {
      showMsg('取得は成功しましたが、対象となる予定が見つかりませんでした', 'info');
    } else {
      showMsg('スケジュールを取得しました。取り込む予定を選択してください', 'success');
    }
  } catch (err) {
    console.error(err);
    showMsg('取得に失敗しました: ' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}

// ─────────────────────────────────────────────────────────
// タスクチェックボックスUI（9節）
// ─────────────────────────────────────────────────────────

function getFilteredTaskIndexes() {
  const indexes = [];
  state.tasks.forEach(function (t, idx) {
    if (state.taskTypeFilter === 'all' || t.kind === state.taskTypeFilter) {
      indexes.push(idx);
    }
  });
  return indexes;
}

function renderTaskList() {
  const section = document.getElementById('taskSection');
  const container = document.getElementById('taskList');
  const countEl = document.getElementById('taskCount');
  container.innerHTML = '';

  if (state.tasks.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

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
    const badge = document.createElement('span');
    badge.className = 'task-type-badge ' + (t.kind === 'event' ? 'event' : 'meeting');
    badge.textContent = t.kind === 'event' ? '終日' : '会議';
    nameEl.appendChild(badge);
    nameEl.appendChild(document.createTextNode(t.taskName));
    const metaEl = document.createElement('div');
    metaEl.className = 'task-meta';
    const dateRange = t.startDate === t.endDate ? t.startDate : (t.startDate + ' 〜 ' + t.endDate);
    const assigneeText = t.assigneeName ? t.assigneeName : '(担当者不明)';
    metaEl.textContent = dateRange + ' / ' + assigneeText;
    main.appendChild(nameEl);
    main.appendChild(metaEl);

    item.appendChild(cb);
    item.appendChild(main);
    container.appendChild(item);
  });
}

function updateTaskCountOnly() {
  const countEl = document.getElementById('taskCount');
  if (!countEl) return;
  const filteredIndexes = getFilteredTaskIndexes();
  const checkedCount = state.tasks.filter(function (t) { return t.checked; }).length;
  countEl.textContent = '表示 ' + filteredIndexes.length + ' / 全 ' + state.tasks.length + ' 件（選択中 ' + checkedCount + ' 件）';
}

/** 全選択・全解除は「現在の種別タブで表示されている行」のみを対象にする */
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
          assignee: t.assigneeName,
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
  document.getElementById('prevWeekBtn').disabled = busy;
  document.getElementById('nextWeekBtn').disabled = busy;
  const importBtn = document.getElementById('importBtn');
  if (importBtn) importBtn.disabled = busy;
  if (busy && message) showMsg(message, 'info');
}
