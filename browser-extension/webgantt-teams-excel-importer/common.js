/**
 * WebGantt Teams Excel Importer — 共通処理モジュール
 * ===================================================
 * 参照: docs/teams-excel-import-design.md 5節・6節・9節
 *
 * 本ファイルは popup.html から <script src="common.js"> で読み込まれる
 * 素朴な非モジュール形式のスクリプト（Manifest V3のpopup内で完結するため
 * import/export は使わず window直下に関数を生やす）。
 *
 * 提供する関数:
 *   - WGT.detectWeekBlocks(workbook)      : 5.2節 週ブロック検出
 *   - WGT.splitCellIntoTasks(cellValue)   : 9.2節 セル内改行分割
 *   - WGT.mergeConsecutiveSameNameTasks(items) : 9.3節 同一名称タスク日またぎ結合(週またぎ含む)
 *   - WGT.extractTasksFromWorkbook(workbook) : 上記を組み合わせた一連の抽出処理
 *   - WGT.matchAssigneeToMember(rawName, members) : 8.4節 苗字部分一致マッチング
 */
(function (global) {
  'use strict';

  const WGT = {};

  // ─────────────────────────────────────────────────────────
  // 日付ユーティリティ
  // ─────────────────────────────────────────────────────────

  /** Excelの日付値（Dateオブジェクト or シリアル値 or 文字列）を 'YYYY-MM-DD' に正規化する */
  function toIsoDate(value) {
    if (value == null) return null;
    if (value instanceof Date) {
      return formatDate(value);
    }
    if (typeof value === 'number') {
      // Excelシリアル値（SheetJSのSSF変換に頼らず素朴に計算。1900年うるう年バグは本用途では無視してよい）
      const utcDays = value - 25569; // 1970-01-01 との差(日数)
      const utcMs = utcDays * 86400 * 1000;
      return formatDate(new Date(utcMs));
    }
    if (typeof value === 'string') {
      const s = value.trim();
      // 既に YYYY-MM-DD 形式ならそのまま
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      if (!isNaN(d.getTime())) return formatDate(d);
      return null;
    }
    return null;
  }

  function formatDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** 'YYYY-MM-DD' を Date(UTCではなくローカル日付として0時)に変換 */
  function parseIsoDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  /** 2つの日付(ISO文字列)が「連続する営業日」かどうかを判定する。
   *  設計書9.3節: 土日を挟んだ週またぎ（金曜→翌週月曜）も連続とみなす。
   *  すなわち、間に土曜・日曜（非営業日）のみを挟む場合は連続。
   *  平日どうしが1日超えている場合（例: 火→木、間に空白の水がある）は連続とみなさない。
   */
  function isNextBusinessDay(prevIso, nextIso) {
    const prev = parseIsoDate(prevIso);
    const next = parseIsoDate(nextIso);
    const diffDays = Math.round((next - prev) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return false;
    if (diffDays === 1) return true; // 翌日（月〜木→翌日、いずれも平日想定）
    // 金曜(5)→翌週月曜: 中間に土日のみを挟む場合を許容する。
    // prevの曜日が金曜(5)で、diffDaysが3日（金→月）の場合のみ連続とみなす。
    const prevDow = prev.getDay(); // 0=日,1=月,...,6=土
    if (prevDow === 5 && diffDays === 3) {
      // 間の2日が土(6)・日(0)であることを確認
      const mid1 = new Date(prev); mid1.setDate(mid1.getDate() + 1);
      const mid2 = new Date(prev); mid2.setDate(mid2.getDate() + 2);
      if (mid1.getDay() === 6 && mid2.getDay() === 0) return true;
    }
    // 祝日等で土日以外の休みを挟むケースは本フェーズでは非対応（設計書に記載なし、将来検討事項）
    return false;
  }

  // ─────────────────────────────────────────────────────────
  // シート選択ユーティリティ
  // ─────────────────────────────────────────────────────────

  /**
   * ワークブック内から取り込み対象のシートを自動選択する。
   * 優先順位: (1) シート名に「週間予定表」を含むシート
   *           (2) データが入っている(!refを持つ)最初のシート
   *           (3) それでも無ければ先頭シート
   * サンプルファイルでは "Sheet1"(空) + "週間予定表" という構成のため、
   * 単純に先頭シートを使うと空振りする。運用先のファイルでもシート構成が
   * 変動する可能性を考慮し、名前一致を最優先にした上でデータ有無で
   * フォールバックする。
   */
  WGT.pickDefaultSheet = function (workbook) {
    const byName = workbook.SheetNames.find(function (n) { return n.indexOf('週間予定表') !== -1; });
    if (byName) return byName;

    const withData = workbook.SheetNames.find(function (n) {
      const s = workbook.Sheets[n];
      return s && s['!ref'];
    });
    if (withData) return withData;

    return workbook.SheetNames[0];
  };

  // ─────────────────────────────────────────────────────────
  // 5.2節: 週ブロック検出ロジック
  // ─────────────────────────────────────────────────────────

  /**
   * ワークシート(SheetJSのsheetオブジェクト、cellDates:trueで読み込み済み想定)から
   * 週ブロックの配列を検出する。
   * 返却形式: [{ headerRow, memberStartRow, memberEndRow, dateColumns: [{col, date}], allScheduleRow }]
   *   - headerRow: 日付ヘッダー行のインデックス(0オリジン)
   *   - allScheduleRow: 「全体予定」行のインデックス
   *   - memberStartRow〜memberEndRow: メンバー行の範囲(inclusive)
   *   - dateColumns: 日付が入っている列とその日付(ISO文字列)の配列
   */
  WGT.detectWeekBlocks = function (sheet) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const blocks = [];
    const MAX_WEEKS = 4;

    for (let r = range.s.r; r <= range.e.r && blocks.length < MAX_WEEKS; r++) {
      // この行で「日付らしき値が2つ以上横に並んでいるか」を調べる
      const dateColumns = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[cellRef];
        if (!cell) continue;
        const iso = extractDateFromCell(cell);
        if (iso) dateColumns.push({ col: c, date: iso });
      }
      if (dateColumns.length < 2) continue; // 週ヘッダー行の候補ではない

      // 直後の行が「全体予定」固定文字列であることを確認
      const allScheduleRow = r + 1;
      const aCellRef = XLSX.utils.encode_cell({ r: allScheduleRow, c: range.s.c });
      const aCell = sheet[aCellRef];
      const aText = aCell ? String(aCell.v).trim() : '';
      if (aText !== '全体予定') {
        // 一致しない場合はその週ブロックをスキップ(警告ログのみ)
        console.warn('[WGT] 週ヘッダー候補行', r, 'の直後が「全体予定」ではないためスキップ:', aText);
        continue;
      }

      // 「全体予定」行の次から、次の空行 or 次の週ヘッダー行が現れるまでをメンバー行として収集
      let memberStartRow = allScheduleRow + 1;
      let memberEndRow = memberStartRow - 1;
      for (let mr = memberStartRow; mr <= range.e.r; mr++) {
        const nameCellRef = XLSX.utils.encode_cell({ r: mr, c: range.s.c });
        const nameCell = sheet[nameCellRef];
        const nameText = nameCell ? String(nameCell.v).trim() : '';
        if (nameText === '') break; // 空行 = 週ブロックの区切り
        memberEndRow = mr;
      }

      blocks.push({
        headerRow: r,
        allScheduleRow,
        memberStartRow,
        memberEndRow,
        dateColumns,
      });

      // 次の週ブロック探索はこのブロックの終端より後から
      r = memberEndRow;
    }

    // 週の並び順を時系列順(日付が若い順)に正規化する
    blocks.sort(function (a, b) {
      const da = a.dateColumns[0] ? a.dateColumns[0].date : '';
      const db = b.dateColumns[0] ? b.dateColumns[0].date : '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return blocks;
  };

  function extractDateFromCell(cell) {
    if (cell.t === 'd' && cell.v instanceof Date) {
      return formatDate(cell.v);
    }
    if (cell.t === 'n' && typeof cell.v === 'number' && cell.v > 20000 && cell.v < 60000) {
      // 日付らしきシリアル値の範囲(おおよそ1954年〜2064年)のみ日付として扱う
      return toIsoDate(cell.v);
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // 9.2節: セル内改行区切りテキストの複数タスク分割
  // ─────────────────────────────────────────────────────────

  WGT.splitCellIntoTasks = function (cellValue) {
    if (!cellValue) return [];
    return String(cellValue)
      .split(/\r\n|\r|\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  };

  // ─────────────────────────────────────────────────────────
  // 9.3節: 同一名称タスクの日またぎ結合（週またぎ含む）
  // ─────────────────────────────────────────────────────────

  /**
   * items: [{ assignee, taskName, date }] のフラットな配列
   * 戻り値: [{ assignee, taskName, startDate, endDate }] （結合済み）
   */
  WGT.mergeConsecutiveSameNameTasks = function (items) {
    // 1. assignee + taskName の組み合わせでグループ化
    const groups = new Map();
    items.forEach(function (item) {
      const key = (item.assignee || '') + '\u0000' + item.taskName;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });

    const result = [];
    groups.forEach(function (groupItems, key) {
      // 2. date昇順ソート（同一日重複は除去）
      const uniqueDates = Array.from(new Set(groupItems.map(function (g) { return g.date; }))).sort();
      const assignee = groupItems[0].assignee;
      const taskName = groupItems[0].taskName;

      let rangeStart = uniqueDates[0];
      let rangeEnd = uniqueDates[0];

      for (let i = 1; i < uniqueDates.length; i++) {
        const cur = uniqueDates[i];
        if (isNextBusinessDay(rangeEnd, cur)) {
          // 3. 連続とみなし範囲を延長
          rangeEnd = cur;
        } else {
          // 4. 連続していない場合はここで一旦区切る
          result.push({ assignee: assignee, taskName: taskName, startDate: rangeStart, endDate: rangeEnd });
          rangeStart = cur;
          rangeEnd = cur;
        }
      }
      result.push({ assignee: assignee, taskName: taskName, startDate: rangeStart, endDate: rangeEnd });
    });

    // 開始日順に並べ替えて返す（UI表示を安定させるため）
    result.sort(function (a, b) {
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
      return a.taskName < b.taskName ? -1 : a.taskName > b.taskName ? 1 : 0;
    });
    return result;
  };

  // ─────────────────────────────────────────────────────────
  // 8.4節: 苗字部分一致マッチング
  // ─────────────────────────────────────────────────────────

  /**
   * rawName: Excel側の氏名文字列（苗字のみ or フルネーム）
   * members: プロジェクトメンバーの表示名配列
   * 戻り値: マッチしたメンバー表示名。マッチしない場合は rawName をそのまま返す
   */
  WGT.matchAssigneeToMember = function (rawName, members) {
    if (!rawName) return '';
    const name = String(rawName).trim();
    if (name === '') return '';
    if (!Array.isArray(members) || members.length === 0) return name;

    for (const m of members) {
      if (!m) continue;
      const displayName = String(m).trim();
      if (displayName === '') continue;
      if (displayName.indexOf(name) !== -1) return displayName; // メンバー名にExcel側の文字列が含まれる(苗字一致)
      if (name.indexOf(displayName) !== -1) return displayName; // Excel側の文字列にメンバー名が含まれる
    }
    return name; // マッチしない場合は生文字列のまま
  };

  // ─────────────────────────────────────────────────────────
  // ワークブック全体からのタスク抽出（週ブロック検出 → セル抽出 → 改行分割 → 日またぎ結合）
  // ─────────────────────────────────────────────────────────

  /**
   * workbook: XLSX.read() の戻り値
   * options: { sheetName?: string, selectedWeekIndexes?: number[] }
   * 戻り値: { weeks: [{ startDate, endDate }], tasks: [{ assignee, taskName, startDate, endDate }] }
   */
  WGT.extractTasksFromWorkbook = function (workbook, options) {
    options = options || {};
    const sheetName = options.sheetName || WGT.pickDefaultSheet(workbook);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);

    const blocks = WGT.detectWeekBlocks(sheet);
    const selectedIdx = options.selectedWeekIndexes; // undefinedなら全週

    const flatItems = []; // { assignee, taskName, date }
    const weekSummaries = [];

    blocks.forEach(function (block, idx) {
      const weekStart = block.dateColumns[0].date;
      const weekEnd = block.dateColumns[block.dateColumns.length - 1].date;
      weekSummaries.push({ index: idx, startDate: weekStart, endDate: weekEnd });

      if (Array.isArray(selectedIdx) && selectedIdx.indexOf(idx) === -1) return; // この週は未選択

      // 「全体予定」行 + メンバー行を1本の配列として処理
      const rowsToProcess = [block.allScheduleRow];
      for (let r = block.memberStartRow; r <= block.memberEndRow; r++) rowsToProcess.push(r);

      rowsToProcess.forEach(function (r) {
        const isAllSchedule = (r === block.allScheduleRow);
        const nameCellRef = XLSX.utils.encode_cell({ r: r, c: block.dateColumns[0].col - 1 >= 0 ? 0 : 0 });
        // A列(先頭列)に氏名がある前提。dateColumnsの最小colより前の列(=先頭列)から取得する。
        const firstCol = Math.min.apply(null, block.dateColumns.map(function (d) { return d.col; })) - 1;
        const nameCol = firstCol >= 0 ? firstCol : 0;
        const nameRef = XLSX.utils.encode_cell({ r: r, c: nameCol });
        const nameCell = sheet[nameRef];
        const rawAssignee = isAllSchedule ? '' : (nameCell ? String(nameCell.v).trim() : '');

        block.dateColumns.forEach(function (dc) {
          const cellRef = XLSX.utils.encode_cell({ r: r, c: dc.col });
          const cell = sheet[cellRef];
          if (!cell || cell.v == null || String(cell.v).trim() === '') return; // 空セルは対象外(機能仕様3)

          const taskNames = WGT.splitCellIntoTasks(cell.v); // 9.2節
          taskNames.forEach(function (taskName) {
            flatItems.push({ assignee: rawAssignee, taskName: taskName, date: dc.date });
          });
        });
      });
    });

    const mergedTasks = WGT.mergeConsecutiveSameNameTasks(flatItems); // 9.3節（週またぎ含む）

    return { weeks: weekSummaries, tasks: mergedTasks };
  };

  global.WGT = WGT;
})(typeof window !== 'undefined' ? window : globalThis);
