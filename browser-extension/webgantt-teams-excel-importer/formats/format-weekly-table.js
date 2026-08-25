/**
 * WebGantt Teams Excel Importer — フォーマット「予定表フォーマットA：週間予定表（全体予定＋メンバー行）」
 * ===================================================================================
 * 内部ID: weekly-table
 * 参照: docs/teams-excel-import-design.md 5節・6節・9節
 *
 * 【2026-08-24】common.js から本ファイルへ移設（複数フォーマット対応のための分離）。
 * ロジックは移設前と一切変更していない（単純なファイル分割のみ）。
 *
 * シート構造（5.1節）:
 *   行1:      タイトル「週間予定表」
 *   行4:      日付ヘッダー行（B列〜F列に月〜金の日付）
 *   行5:      「全体予定」行（A列に固定文字列、B〜F列が該当日の予定セル）
 *   行6〜18:  メンバー行（A列にメンバー名、B〜F列が該当日の予定セル）
 *   行19:     空行（週ブロックの区切り）
 *   ...（最大4週分繰り返し）
 *
 * 本ファイルは popup.html/options.html から
 * <script src="formats/format-weekly-table.js"> で読み込まれる。
 * common.js（WGT名前空間）より後に読み込むこと（WGT.registerFormat等に依存するため）。
 */
(function (global) {
  'use strict';

  const WGT = global.WGT;
  if (!WGT) {
    throw new Error('format-weekly-table.js: common.js が先に読み込まれている必要があります');
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
  function pickDefaultSheet(workbook) {
    const byName = workbook.SheetNames.find(function (n) { return n.indexOf('週間予定表') !== -1; });
    if (byName) return byName;

    const withData = workbook.SheetNames.find(function (n) {
      const s = workbook.Sheets[n];
      return s && s['!ref'];
    });
    if (withData) return withData;

    return workbook.SheetNames[0];
  }

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
  function detectWeekBlocks(sheet) {
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
        const iso = WGT.extractDateFromCell(cell);
        if (iso) dateColumns.push({ col: c, date: iso });
      }
      if (dateColumns.length < 2) continue; // 週ヘッダー行の候補ではない

      // 直後の行を「全体予定」行として扱う（位置ベース判定・案A）。
      // 当初は直後行のA列が「全体予定」固定文字列と完全一致することを
      // 条件にしていたが、実際の運用ファイルでは「出図\r\n休暇\r\n全体」
      // のような色分け凡例の文言が入っており完全一致しないケースが
      // あることが判明した（ユーザー実機での動作確認で発覚）。
      // ラベルの文言に関わらず、「日付ヘッダー行の直後の行」を無条件に
      // 全体予定行とみなす方式に変更する。ただし空行の場合は週ブロックの
      // 体をなしていない可能性が高いため、その場合のみログを出しつつ
      // 処理は継続する（インポート対象からは自然に除外される＝
      // 「全体予定」テキストが空ならタスクとして生成されないため実害はない）。
      const allScheduleRow = r + 1;
      const aCellRef = XLSX.utils.encode_cell({ r: allScheduleRow, c: range.s.c });
      const aCell = sheet[aCellRef];
      const aText = aCell ? String(aCell.v).trim() : '';
      if (aText === '') {
        console.warn('[WGT] 週ヘッダー候補行', r, 'の直後行(全体予定行扱い)のA列が空です。行:', allScheduleRow);
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
  }

  // ─────────────────────────────────────────────────────────
  // ワークブック全体からのタスク抽出（週ブロック検出 → セル抽出 → 改行分割 → 日またぎ結合）
  // ─────────────────────────────────────────────────────────

  /**
   * workbook: XLSX.read() の戻り値
   * options: { sheetName?: string, selectedWeekIndexes?: number[] }
   * 戻り値: { weeks: [{ startDate, endDate }], tasks: [{ assignee, taskName, startDate, endDate }] }
   */
  function extractTasksFromWorkbook(workbook, options) {
    options = options || {};
    const sheetName = options.sheetName || pickDefaultSheet(workbook);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);

    const blocks = detectWeekBlocks(sheet);
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
  }

  // ─────────────────────────────────────────────────────────
  // フォーマット登録インターフェース（listWeeks / extractTasks）
  // ─────────────────────────────────────────────────────────

  /** 週一覧のみを検出する軽量版（週チェックボックス表示用） */
  function listWeeks(workbook) {
    const sheetName = pickDefaultSheet(workbook);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    const blocks = detectWeekBlocks(sheet);
    return blocks.map(function (b) {
      return { startDate: b.dateColumns[0].date, endDate: b.dateColumns[b.dateColumns.length - 1].date };
    });
  }

  /** フォーマット共通インターフェース: タスク抽出（selectedWeekIndexesで週を絞り込み） */
  function extractTasks(workbook, options) {
    return extractTasksFromWorkbook(workbook, options);
  }

  WGT.registerFormat({
    id: 'weekly-table',
    label: '予定表フォーマットA：週間予定表（全体予定＋メンバー行）',
    listWeeks: listWeeks,
    extractTasks: extractTasks,
  });

  // デバッグ・単体テスト用に内部関数もエクスポートしておく（既存の動作互換のため）
  WGT.formats = WGT.formats || {};
  WGT.formats.weeklyTable = {
    pickDefaultSheet: pickDefaultSheet,
    detectWeekBlocks: detectWeekBlocks,
    extractTasksFromWorkbook: extractTasksFromWorkbook,
  };
})(typeof window !== 'undefined' ? window : globalThis);
