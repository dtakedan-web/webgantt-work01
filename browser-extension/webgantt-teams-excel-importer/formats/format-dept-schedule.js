/**
 * WebGantt Teams Excel Importer — フォーマット「部署別週間予定表（機種/業務別・シート週別）」
 * ===========================================================================================
 * 内部ID: dept-schedule
 * 参照: docs/teams-excel-import-design.md 18節（複数フォーマット対応、新規追加分）
 *
 * ユーザー提供サンプル「別フォーマット週間予定表(サンプル).xlsx」の解析結果に基づく仕様:
 *
 * シート構造（標準週間予定表フォーマットとの主な違い）:
 *   - 週の単位が「1シート＝1週」（シート名は日付だが、シート名の文字列は使わず、
 *     シート内の日付ヘッダーの実データから週の開始日・終了日を判定する。⑥確定事項）
 *   - 「全体予定」行に相当するものは存在しない
 *   - 担当者(B列)の下に、複数の「機種/業務」(C列)行がぶら下がる2階層構造
 *     （B列は担当者ごとに複数行を結合したセル、C列は結合なしで1行ごとに独立）
 *
 * 行構造（実データで確認・0オリジンではなくExcel行番号で記載）:
 *   行1:   タイトル行（部署名等、未使用）
 *   行3:   ヘッダー行。B3=担当, C3=機種/業務, D3/F3/H3/J3/L3=日付（各2列结合、月〜金）, N3=備考
 *   行4:   曜日ラベル行（D4=月, F4=火, ...。未使用、行3の日付があれば十分なため）
 *   行5〜: データ行。A列=部署（無視・②確定）, B列=担当者（結合セル、forward-fill要）,
 *          C列=機種/業務（結合なし、行ごと）, D/F/H/J/L列=該当日の予定セル, N列=備考（無視・③確定）
 *
 * タスク名の生成（①確定: (b)を採用）:
 *   「機種/業務: セル内容」の形式（例: "Aシリーズ: ﾃﾞﾊﾞｯｸﾞ"）
 *   ただし、C列（機種/業務）が空の行（実データで存在を確認: 例 "PJ"や"面談"のような
 *   機種非依存の予定、または研修等でC列を使わない担当者行）については、
 *   プレフィックスを付けず、セル内容のみをタスク名とするフォールバックとする
 *   （設計確認時には明示的に扱いを決めていなかった実データ上のケースのため、
 *   「データを欠落させない」ことを優先した実装判断。ご確認の上、必要であれば
 *   仕様変更を承ります）。
 *
 * 空セル・改行分割・日またぎ結合・苗字部分一致マッチングは標準週間予定表と共通の
 * ロジック（common.js側）をそのまま使用する（④確定）。
 *
 * 本ファイルは popup.html/options.html から
 * <script src="formats/format-dept-schedule.js"> で読み込まれる。
 * common.js（WGT名前空間）より後に読み込むこと。
 */
(function (global) {
  'use strict';

  const WGT = global.WGT;
  if (!WGT) {
    throw new Error('format-dept-schedule.js: common.js が先に読み込まれている必要があります');
  }

  // ─────────────────────────────────────────────────────────
  // シート内の日付ヘッダー行検出（標準フォーマットと同じ「日付が2つ以上横に並ぶ行」判定を流用）
  // ─────────────────────────────────────────────────────────

  /**
   * シート内から日付ヘッダー行を検出する。
   * 戻り値: { headerRow, dateColumns: [{col, date}] } または見つからない場合 null
   */
  function findHeaderRow(sheet, range) {
    for (let r = range.s.r; r <= range.e.r; r++) {
      const dateColumns = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cellRef = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[cellRef];
        if (!cell) continue;
        const iso = WGT.extractDateFromCell(cell);
        if (iso) dateColumns.push({ col: c, date: iso });
      }
      if (dateColumns.length >= 2) {
        return { headerRow: r, dateColumns: dateColumns };
      }
    }
    return null; // このシートには日付ヘッダー行が無い＝対象外のシートとして自然にスキップ（⑥確定）
  }

  /**
   * 1シート分を解析し、{ startDate, endDate, sheetName, dateColumns, taskCol, assigneeCol, dataStartRow, sheet, range }
   * を返す。日付ヘッダー行が見つからない場合は null（対象外シートとしてスキップ）。
   */
  function analyzeSheet(workbook, sheetName) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) return null;
    const range = XLSX.utils.decode_range(sheet['!ref']);

    const headerInfo = findHeaderRow(sheet, range);
    if (!headerInfo) return null;

    const dateColumns = headerInfo.dateColumns;
    const firstDateCol = Math.min.apply(null, dateColumns.map(function (d) { return d.col; }));
    const taskCol = firstDateCol - 1;    // C列相当（機種/業務）
    const assigneeCol = firstDateCol - 2; // B列相当（担当者）
    if (taskCol < range.s.c || assigneeCol < range.s.c) return null; // 列構成が想定と異なる場合はスキップ

    // データ開始行: ヘッダー行の直下は曜日ラベル行（未使用）のため、その次の行から
    const dataStartRow = headerInfo.headerRow + 2;

    const sortedDates = dateColumns.map(function (d) { return d.date; }).sort();
    return {
      sheetName: sheetName,
      startDate: sortedDates[0],
      endDate: sortedDates[sortedDates.length - 1],
      dateColumns: dateColumns,
      taskCol: taskCol,
      assigneeCol: assigneeCol,
      dataStartRow: dataStartRow,
      dataEndRow: range.e.r,
      sheet: sheet,
    };
  }

  /** ワークブック内の全シートを解析し、有効な週（シート）を開始日昇順で返す */
  function analyzeAllSheets(workbook) {
    const analyzed = workbook.SheetNames
      .map(function (name) { return analyzeSheet(workbook, name); })
      .filter(function (a) { return a !== null; });
    analyzed.sort(function (a, b) { return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0; });
    return analyzed;
  }

  /** 1シート分のデータ行を走査し、flatItems（{assignee, taskName, date}）に追加する */
  function extractItemsFromSheetInfo(sheetInfo, flatItems) {
    const sheet = sheetInfo.sheet;
    let currentAssignee = ''; // B列は担当者ごとに結合セルのため、forward-fillで値を引き継ぐ

    for (let r = sheetInfo.dataStartRow; r <= sheetInfo.dataEndRow; r++) {
      const assigneeCellRef = XLSX.utils.encode_cell({ r: r, c: sheetInfo.assigneeCol });
      const assigneeCell = sheet[assigneeCellRef];
      const assigneeText = assigneeCell && assigneeCell.v != null ? String(assigneeCell.v).trim() : '';
      if (assigneeText !== '') currentAssignee = assigneeText;

      const taskCellRef = XLSX.utils.encode_cell({ r: r, c: sheetInfo.taskCol });
      const taskCell = sheet[taskCellRef];
      const taskLabel = taskCell && taskCell.v != null ? String(taskCell.v).trim() : '';

      sheetInfo.dateColumns.forEach(function (dc) {
        const cellRef = XLSX.utils.encode_cell({ r: r, c: dc.col });
        const cell = sheet[cellRef];
        if (!cell || cell.v == null || String(cell.v).trim() === '') return; // 空セルは対象外

        const cellTexts = WGT.splitCellIntoTasks(cell.v); // セル内改行分割（共通ロジック）
        cellTexts.forEach(function (cellText) {
          // ①確定: 「機種/業務: セル内容」形式。機種/業務(C列)が空の行はプレフィックスなしにフォールバック
          const taskName = taskLabel !== '' ? (taskLabel + ': ' + cellText) : cellText;
          flatItems.push({ assignee: currentAssignee, taskName: taskName, date: dc.date });
        });
      });
    }
  }

  // ─────────────────────────────────────────────────────────
  // フォーマット登録インターフェース（listWeeks / extractTasks）
  // ─────────────────────────────────────────────────────────

  /** 週一覧のみを検出する軽量版（週チェックボックス表示用。⑤確定: シートが増えても全件表示） */
  function listWeeks(workbook) {
    const analyzed = analyzeAllSheets(workbook);
    return analyzed.map(function (a) {
      return { startDate: a.startDate, endDate: a.endDate };
    });
  }

  /** フォーマット共通インターフェース: タスク抽出（selectedWeekIndexesで週=シートを絞り込み） */
  function extractTasks(workbook, options) {
    options = options || {};
    const analyzed = analyzeAllSheets(workbook);
    const selectedIdx = options.selectedWeekIndexes; // undefinedなら全週

    const flatItems = [];
    analyzed.forEach(function (sheetInfo, idx) {
      if (Array.isArray(selectedIdx) && selectedIdx.indexOf(idx) === -1) return; // この週は未選択
      extractItemsFromSheetInfo(sheetInfo, flatItems);
    });

    const mergedTasks = WGT.mergeConsecutiveSameNameTasks(flatItems); // 日またぎ結合（共通ロジック・④確定）
    return { tasks: mergedTasks };
  }

  WGT.registerFormat({
    id: 'dept-schedule',
    label: '部署別週間予定表（機種/業務別・シート週別）',
    listWeeks: listWeeks,
    extractTasks: extractTasks,
  });

  // デバッグ・単体テスト用に内部関数もエクスポートしておく
  WGT.formats = WGT.formats || {};
  WGT.formats.deptSchedule = {
    findHeaderRow: findHeaderRow,
    analyzeSheet: analyzeSheet,
    analyzeAllSheets: analyzeAllSheets,
  };
})(typeof window !== 'undefined' ? window : globalThis);
