/**
 * WebGantt Teams Excel Importer — 共通処理モジュール
 * ===================================================
 * 参照: docs/teams-excel-import-design.md 5節・6節・9節・18節（複数フォーマット対応）
 *
 * 本ファイルは popup.html / options.html から <script src="common.js"> で
 * 読み込まれる素朴な非モジュール形式のスクリプト（Manifest V3のpopup内で
 * 完結するため import/export は使わず window直下に関数を生やす）。
 *
 * 提供する関数（汎用ユーティリティのみ。フォーマット固有ロジックは
 * formats/format-*.js 側に分離されている。18節参照）:
 *   - WGT.splitCellIntoTasks(cellValue)          : 9.2節 セル内改行分割（フォーマット共通）
 *   - WGT.mergeConsecutiveSameNameTasks(items)   : 9.3節 同一名称タスク日またぎ結合（フォーマット共通）
 *   - WGT.matchAssigneeToMember(rawName, members): 8.4節 苗字部分一致マッチング（フォーマット共通）
 *   - WGT.extractDateFromCell(cell)              : セルが日付らしき値か判定しISO文字列化（フォーマット共通）
 *   - WGT.toIsoDate / WGT.formatDate / WGT.parseIsoDate / WGT.isNextBusinessDay : 日付ユーティリティ
 *   - WGT.extractSiteBaseUrl(shareUrl)           : 共有リンクからSharePointサイト基点URLを推測（popup.js/options.js共用）
 *   - WGT.encodeSharingUrl(sharingUrl)           : shares APIエンコード（popup.js/options.js共用）
 *   - WGT.registerFormat(formatDef) / WGT.getFormat(id) / WGT.listFormats() / WGT.DEFAULT_FORMAT_ID
 *       : 複数エクセルフォーマット対応のためのフォーマット登録レジストリ（18節）
 *
 * 【2026-08-23追記】options.js（初回設定画面）の保存時接続テストのため、
 * popup.js内にのみ存在していた extractSiteBaseUrl/encodeSharingUrl を
 * 本ファイルへ移設し、popup.js・options.js の両方から共用する形に変更した。
 *
 * 【2026-08-24追記】複数のエクセル予定表フォーマットに対応するため、旧来
 * このファイルに存在した「週間予定表（全体予定＋メンバー行）」専用の解析
 * ロジック（pickDefaultSheet/detectWeekBlocks/extractTasksFromWorkbook）を
 * formats/format-weekly-table.js へ移設した（ロジック自体は無変更の単純
 * 分割）。代わりに、フォーマットを追加・切り替え可能にするための登録
 * レジストリ（WGT.registerFormat 等）を新設した。各フォーマットは
 * { id, label, listWeeks(workbook), extractTasks(workbook, options) } の
 * インターフェースで自己登録する。
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

  WGT.toIsoDate = toIsoDate;
  WGT.formatDate = formatDate;
  WGT.parseIsoDate = parseIsoDate;
  WGT.isNextBusinessDay = isNextBusinessDay;

  // ─────────────────────────────────────────────────────────
  // セルの日付判定（フォーマット共通・各format-*.js の週ヘッダー検出から利用）
  // ─────────────────────────────────────────────────────────

  /**
   * SheetJSのセルオブジェクトが「日付らしき値」かどうかを判定し、ISO文字列を返す。
   * 日付でなければ null を返す。
   */
  WGT.extractDateFromCell = function (cell) {
    if (!cell) return null;
    if (cell.t === 'd' && cell.v instanceof Date) {
      return formatDate(cell.v);
    }
    if (cell.t === 'n' && typeof cell.v === 'number' && cell.v > 20000 && cell.v < 60000) {
      // 日付らしきシリアル値の範囲(おおよそ1954年〜2064年)のみ日付として扱う
      return toIsoDate(cell.v);
    }
    return null;
  };

  // ─────────────────────────────────────────────────────────
  // 9.2節: セル内改行区切りテキストの複数タスク分割（フォーマット共通）
  // ─────────────────────────────────────────────────────────

  WGT.splitCellIntoTasks = function (cellValue) {
    if (!cellValue) return [];
    return String(cellValue)
      .split(/\r\n|\r|\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  };

  // ─────────────────────────────────────────────────────────
  // 9.3節: 同一名称タスクの日またぎ結合（週またぎ含む・フォーマット共通）
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
  // 8.4節: 苗字部分一致マッチング（フォーマット共通）
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
  // SharePoint共有リンク関連ユーティリティ（元popup.js、options.js保存時テストのため共通化）
  // ─────────────────────────────────────────────────────────

  /** 共有URLから、Cookie認証チェック(currentuser API)に使うサイト基点URLを推測する。
   * 例: https://suzumond.sharepoint.com/:x:/s/msteams_b3d137/xxxxx
   *  → https://suzumond.sharepoint.com/sites/msteams_b3d137 相当のURLパターンを推測
   * パターンに一致しない場合はオリジンのみを返す(この場合 currentuser が404になる可能性あり、
   * その際はエラーメッセージでユーザーに共有リンクの確認を促す)。
   */
  WGT.extractSiteBaseUrl = function (shareUrl) {
    try {
      const u = new URL(shareUrl);
      const m = u.pathname.match(/\/(?:personal|sites|teams)\/([^/]+)/i);
      if (m) {
        const kind = u.pathname.toLowerCase().indexOf('/personal/') !== -1 ? 'personal'
          : u.pathname.toLowerCase().indexOf('/teams/') !== -1 ? 'teams' : 'sites';
        return u.origin + '/' + kind + '/' + m[1];
      }
      return u.origin;
    } catch (e) {
      return '';
    }
  };

  /** Microsoft Graph/SharePoint sharesエンドポイント用の共有URLエンコード（"u!"プレフィックス方式） */
  WGT.encodeSharingUrl = function (sharingUrl) {
    const base64 = btoa(unescape(encodeURIComponent(sharingUrl)));
    const urlSafe = base64.replace(/=/g, '').replace(/\//g, '_').replace(/\+/g, '-');
    return 'u!' + urlSafe;
  };

  // ─────────────────────────────────────────────────────────
  // 18節: 複数エクセルフォーマット対応のためのフォーマット登録レジストリ
  // ─────────────────────────────────────────────────────────
  //
  // 各 formats/format-*.js は、自分自身の読み込み時に以下の形で自己登録する:
  //   WGT.registerFormat({
  //     id: 'weekly-table',           // 内部ID（chrome.storage.localの保存値・変更しないこと）
  //     label: '標準週間予定表（全体予定＋メンバー行）', // 設定画面ドロップダウンの表示名
  //     listWeeks: function (workbook) { ... },          // 週一覧を検出（軽量・週チェックボックス表示用）
  //                                                       // 戻り値: [{ startDate, endDate }, ...]（昇順）
  //     extractTasks: function (workbook, options) { ... } // options.selectedWeekIndexes（配列 or undefined=全週）
  //                                                       // 戻り値: { tasks: [{ assignee, taskName, startDate, endDate }] }
  //   });
  //
  // 新しいフォーマットを追加する場合は formats/format-新規名.js を1ファイル追加し、
  // popup.html・options.html に <script> タグを1行追加するだけでよい
  // （既存フォーマットのファイルには一切手を入れない）。

  const formatRegistry = new Map();

  WGT.registerFormat = function (formatDef) {
    if (!formatDef || !formatDef.id) {
      throw new Error('WGT.registerFormat: id は必須です');
    }
    formatRegistry.set(formatDef.id, formatDef);
  };

  WGT.getFormat = function (id) {
    return formatRegistry.get(id) || null;
  };

  /** 登録済みフォーマット一覧を配列で返す（設定画面ドロップダウン表示用） */
  WGT.listFormats = function () {
    return Array.from(formatRegistry.values());
  };

  /** 拡張機能インストール直後・旧バージョンからの更新直後など、
   *  formatId が未保存の場合に使うデフォルト値（既存ユーザーの動作を維持するため
   *  従来唯一のフォーマットだった 'weekly-table' を指す） */
  WGT.DEFAULT_FORMAT_ID = 'weekly-table';

  global.WGT = WGT;
})(typeof window !== 'undefined' ? window : globalThis);
