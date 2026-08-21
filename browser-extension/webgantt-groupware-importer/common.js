/**
 * WebGantt Groupware Schedule Importer — 共通処理モジュール
 * ===================================================
 * 参照: docs/groupware-schedule-import-design.md 6節・7節・8節
 *
 * 本ファイルは popup.html から <script src="common.js"> で読み込まれる
 * 素朴な非モジュール形式のスクリプト（Manifest V3のpopup内で完結するため
 * import/export は使わず window直下に関数を生やす）。
 *
 * 提供する関数:
 *   - WGG.getSundayOfWeek(baseDate, weekOffset) : 7節 基準週から±週数分ずらした日曜日の日付
 *   - WGG.formatYYYYMMDD(date)                  : displayDateパラメータ用フォーマット
 *   - WGG.isNextBusinessDay(prevIso, nextIso)   : Teams Excel連携 common.js と同一ロジック（8.3節・4.6節②）
 *   - WGG.processSchedules(schedulesArrays)     : ユニーク化(8.1節)・除外(8.2節)・連続日結合(8.3節)を
 *                                                  まとめて実行し、EVENT/SCHEDULE双方のタスク候補を返す
 *   - WGG.matchAssigneeToMember(rawName, members) : Teams Excel連携と同様の表示名正規化（拡張機能側の参考用）
 */
(function (global) {
  'use strict';

  const WGG = {};

  // ─────────────────────────────────────────────────────────
  // 8.2節: 除外キーワード（4.5節: 将来拡張できるよう配列で定義）
  // ─────────────────────────────────────────────────────────
  WGG.EXCLUDED_ALLDAY_KEYWORDS = ['フレックス'];

  // ─────────────────────────────────────────────────────────
  // 日付ユーティリティ
  // ─────────────────────────────────────────────────────────

  /** 'yyyy/mm/dd' 形式の文字列を 'YYYY-MM-DD' に変換する（find_group_weekのstartDateString等）*/
  function slashToIso(slashDate) {
    if (!slashDate) return null;
    const m = String(slashDate).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) return null;
    const y = m[1];
    const mo = String(m[2]).padStart(2, '0');
    const d = String(m[3]).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }

  /** ISO8601文字列（start/endフィールド等）から 'YYYY-MM-DD' の日付部分のみを取り出す */
  function isoDateOnly(isoDateTime) {
    if (!isoDateTime) return null;
    const m = String(isoDateTime).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  /** 'YYYY-MM-DD' を Date(ローカル日付として0時)に変換 */
  function parseIsoDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function formatIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /**
   * 基準日を含む週の日曜日から、weekOffset週分だけ±7日ずらした日曜日の
   * Dateオブジェクトを返す（週選択UI、7節: 過去週も選択可能。weekOffsetは
   * 負数(過去)・0(基準週自身)・正数(未来)いずれも許容する）。
   */
  WGG.getSundayOfWeek = function (baseDate, weekOffset) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() - d.getDay()); // その週の日曜日まで戻す
    d.setDate(d.getDate() + weekOffset * 7);
    return d;
  };

  /** find_group_weekのdisplayDateパラメータ用（YYYYMMDD）にフォーマットする */
  WGG.formatYYYYMMDD = function (date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  };

  /** 表示用（YYYY/MM/DD）フォーマット */
  WGG.formatDisplaySlash = function (date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}/${m}/${d}`;
  };

  /**
   * 2つの日付(ISO文字列)が「連続する営業日」かどうかを判定する。
   * Teams Excel連携 common.js の isNextBusinessDay() と完全に同一のロジック
   * （設計書8.3節・4.6節②: 土日を挟んだ週またぎ（金曜→翌週月曜）も連続とみなす）。
   */
  WGG.isNextBusinessDay = function (prevIso, nextIso) {
    const prev = parseIsoDate(prevIso);
    const next = parseIsoDate(nextIso);
    const diffDays = Math.round((next - prev) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return false;
    if (diffDays === 1) return true; // 翌日（月〜木→翌日、いずれも平日想定）
    // 金曜(5)→翌週月曜: 中間に土日のみを挟む場合を許容する。
    const prevDow = prev.getDay(); // 0=日,1=月,...,6=土
    if (prevDow === 5 && diffDays === 3) {
      const mid1 = new Date(prev); mid1.setDate(mid1.getDate() + 1);
      const mid2 = new Date(prev); mid2.setDate(mid2.getDate() + 2);
      if (mid1.getDay() === 6 && mid2.getDay() === 0) return true;
    }
    // 祝日等で土日以外の休みを挟むケースは本フェーズでは非対応（Teams Excel連携と同じ方針）
    return false;
  };

  // ─────────────────────────────────────────────────────────
  // 6.4節: 予定オブジェクトから日付範囲を取り出す
  // ─────────────────────────────────────────────────────────

  function extractRecordDateRange(record) {
    // startDateString/endDateString(['yyyy/mm/dd','H:mm']) を優先し、
    // なければ start/end(ISO8601) から日付部分を取る。それも無ければeventDate。
    let startDate = null;
    let endDate = null;
    if (Array.isArray(record.startDateString) && record.startDateString[0]) {
      startDate = slashToIso(record.startDateString[0]);
    }
    if (Array.isArray(record.endDateString) && record.endDateString[0]) {
      endDate = slashToIso(record.endDateString[0]);
    }
    if (!startDate) startDate = isoDateOnly(record.start) || isoDateOnly(record.eventDate);
    if (!endDate) endDate = isoDateOnly(record.end) || startDate;
    if (!endDate) endDate = startDate;
    return { startDate, endDate };
  }

  /** startDate〜endDate(いずれもISO文字列、inclusive)の全日付をISO文字列配列で返す */
  function expandDateRange(startIso, endIso) {
    const dates = [];
    let cur = parseIsoDate(startIso);
    const end = parseIsoDate(endIso);
    // 異常に長い範囲(データ不整合)による暴走防止
    let guard = 0;
    while (cur <= end && guard < 366) {
      dates.push(formatIsoDate(cur));
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return dates;
  }

  // ─────────────────────────────────────────────────────────
  // 8.1節: ユニーク化（scheduleKey.code）
  // ─────────────────────────────────────────────────────────

  /**
   * schedules: find_group_weekレスポンスの data.schedules（ユーザー単位配列の配列）
   * 戻り値: 重複除去済みのフラットな予定オブジェクト配列
   *         （各要素に元の全フィールド + targetInfo由来のassigneeCode/assigneeNameを保持）
   */
  function uniqueSchedules(schedulesArrays) {
    const seen = new Map(); // scheduleKey.code(または代替キー) -> record
    if (!Array.isArray(schedulesArrays)) return [];

    schedulesArrays.forEach(function (userArray) {
      if (!Array.isArray(userArray)) return;
      userArray.forEach(function (record) {
        const key = (record.scheduleKey && record.scheduleKey.code)
          ? record.scheduleKey.code
          // scheduleKeyが無い場合のフォールバック（重複除去できないが実害を避ける）
          : (record.type + '\u0000' + record.title + '\u0000' + (record.start || record.eventDate) + '\u0000' + Math.random());
        if (!seen.has(key)) {
          seen.set(key, record);
        }
      });
    });

    return Array.from(seen.values());
  }

  // ─────────────────────────────────────────────────────────
  // 8.2節: 除外ルール
  // ─────────────────────────────────────────────────────────

  function isExcludedAllDayEvent(record) {
    if (record.type !== 'EVENT' || record.allDay !== true) return false;
    const title = String(record.title || '');
    return WGG.EXCLUDED_ALLDAY_KEYWORDS.some(function (kw) { return title.indexOf(kw) !== -1; });
  }

  // ─────────────────────────────────────────────────────────
  // 8.3節: 連続日タスクの結合ロジック（営業日ベース、4.6節②で確定）
  // ─────────────────────────────────────────────────────────

  /**
   * events: uniqueSchedules()適用後、除外ルール適用後の type==="EVENT" レコード配列
   * 戻り値: [{ assigneeCode, assigneeName, taskName, startDate, endDate }]（結合済み）
   *
   * 実装方針: 各レコードの日付範囲（単一レコードで複数日にまたがるものを含む＝
   * 8.3節パターン1）を一旦「1日単位」に展開し、Teams Excel連携9.3節と同一の
   * 「assignee+title でグループ化 → 日付昇順ソート → isNextBusinessDay()で
   * 連続判定して結合」アルゴリズムを適用する（パターン1・パターン2を区別せず、
   * 同一ロジックで両方を自然にカバーする）。
   */
  WGG.mergeConsecutiveAllDayEvents = function (events) {
    // 1. 各レコードを1日単位のフラットな項目に展開する
    const flatItems = [];
    events.forEach(function (record) {
      const { startDate, endDate } = extractRecordDateRange(record);
      if (!startDate) return;
      const assigneeCode = (record.targetInfo && record.targetInfo.code) || '';
      const assigneeName = (record.targetInfo && record.targetInfo.name) || '';
      const taskName = String(record.title || '').trim();
      if (taskName === '') return;
      expandDateRange(startDate, endDate).forEach(function (date) {
        flatItems.push({ assigneeCode, assigneeName, taskName, date });
      });
    });

    // 2. assigneeCode + taskName でグループ化
    const groups = new Map();
    flatItems.forEach(function (item) {
      const key = item.assigneeCode + '\u0000' + item.taskName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const result = [];
    groups.forEach(function (groupItems) {
      // 3. date昇順ソート（同一日重複は除去）
      const uniqueDates = Array.from(new Set(groupItems.map(function (g) { return g.date; }))).sort();
      const assigneeCode = groupItems[0].assigneeCode;
      const assigneeName = groupItems[0].assigneeName;
      const taskName = groupItems[0].taskName;

      let rangeStart = uniqueDates[0];
      let rangeEnd = uniqueDates[0];

      for (let i = 1; i < uniqueDates.length; i++) {
        const cur = uniqueDates[i];
        if (WGG.isNextBusinessDay(rangeEnd, cur)) {
          // 4. 営業日ベースで連続とみなし範囲を延長（土日を挟んでも連続。4.6節②）
          rangeEnd = cur;
        } else {
          // 5. 連続していない場合はここで一旦区切る
          result.push({ assigneeCode, assigneeName, taskName, startDate: rangeStart, endDate: rangeEnd });
          rangeStart = cur;
          rangeEnd = cur;
        }
      }
      result.push({ assigneeCode, assigneeName, taskName, startDate: rangeStart, endDate: rangeEnd });
    });

    // 開始日順に並べ替えて返す（UI表示を安定させるため）
    result.sort(function (a, b) {
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      return a.taskName < b.taskName ? -1 : a.taskName > b.taskName ? 1 : 0;
    });
    return result;
  };

  // ─────────────────────────────────────────────────────────
  // 8.5節: 会議(SCHEDULE)は結合せず個別に扱う
  // ─────────────────────────────────────────────────────────

  function buildMeetingTasks(meetings) {
    return meetings.map(function (record) {
      const { startDate, endDate } = extractRecordDateRange(record);
      return {
        assigneeCode: (record.targetInfo && record.targetInfo.code) || '',
        assigneeName: (record.targetInfo && record.targetInfo.name) || '',
        taskName: String(record.title || '').trim(),
        startDate: startDate,
        endDate: endDate || startDate,
      };
    }).filter(function (t) { return t.taskName !== '' && t.startDate; });
  }

  // ─────────────────────────────────────────────────────────
  // メイン処理: ユニーク化 → 除外 → 結合 をまとめて実行
  // ─────────────────────────────────────────────────────────

  /**
   * schedulesArraysList: 複数週分のfind_group_weekレスポンスから得た
   *                       data.schedules（ユーザー単位配列の配列）の配列
   *                       （週ごとのレスポンスをそのまま配列にpushしたもの）
   * 戻り値: { events: [...], meetings: [...] }（いずれも8.6節フィールドマッピング前の中間形式）
   */
  WGG.processSchedules = function (schedulesArraysList) {
    // 複数週分のschedules(ユーザー単位配列の配列)をすべて連結してから
    // 一括でユニーク化する（7節: 週境界をまたいだ連続日判定のため）
    const allUserArrays = [];
    (schedulesArraysList || []).forEach(function (schedulesArrays) {
      if (Array.isArray(schedulesArrays)) {
        schedulesArrays.forEach(function (userArray) { allUserArrays.push(userArray); });
      }
    });

    const uniqueRecords = uniqueSchedules(allUserArrays); // 8.1節

    const eventRecords = [];
    const meetingRecords = [];
    uniqueRecords.forEach(function (record) {
      if (record.type === 'EVENT') {
        if (isExcludedAllDayEvent(record)) return; // 8.2節: 一律除外
        eventRecords.push(record);
      } else if (record.type === 'SCHEDULE') {
        meetingRecords.push(record);
      }
    });

    const mergedEvents = WGG.mergeConsecutiveAllDayEvents(eventRecords); // 8.3節
    const meetings = buildMeetingTasks(meetingRecords); // 8.5節（結合なし）

    return { events: mergedEvents, meetings: meetings };
  };

  // ─────────────────────────────────────────────────────────
  // 8.4節・10.3節: 担当者名のメンバー一覧との正規化（参考、サーバー側でも二重チェックする）
  // ─────────────────────────────────────────────────────────

  WGG.matchAssigneeToMember = function (rawName, members) {
    if (!rawName) return '';
    const name = String(rawName).trim();
    if (name === '') return '';
    if (!Array.isArray(members) || members.length === 0) return name;

    for (const m of members) {
      if (!m) continue;
      const displayName = String(m).trim();
      if (displayName === '') continue;
      if (displayName.indexOf(name) !== -1) return displayName;
      if (name.indexOf(displayName) !== -1) return displayName;
    }
    return name;
  };

  global.WGG = WGG;
})(typeof window !== 'undefined' ? window : globalThis);
