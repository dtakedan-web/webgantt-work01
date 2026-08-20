/**
 * WebGantt グループウェア調査ツール - content_bridge.js
 * =============================================
 * ISOLATED world(拡張機能側の権限を持つ通常のcontent script環境)で動作する。
 * injected.js(MAIN world、ページ本体のJS)から window.postMessage() で送られてくる
 * fetch/XHR通信の記録を受け取り、chrome.storage.local に蓄積する。
 * また、DOM(特にカレンダー描画部分)の変化を MutationObserver で監視し、
 * 変化が収まったタイミングで outerHTML のスナップショットを記録する。
 *
 * ページ側の console.clear() 等の妨害の影響を受けないよう、
 * データは常に chrome.storage.local に保存する(コンソールには依存しない)。
 *
 * 【調査専用ツールについて】設計調査完了後は拡張機能自体を削除してよい。
 */
(function () {
  var STORAGE_KEY = 'wgi_records';
  var MAX_RECORDS = 500; // 記録上限(超えたら古いものから捨てる)
  var buffer = [];
  var flushTimer = null;

  function flush() {
    if (buffer.length === 0) return;
    var toAdd = buffer.splice(0, buffer.length);
    chrome.storage.local.get([STORAGE_KEY], function (res) {
      var records = (res && res[STORAGE_KEY]) || [];
      records = records.concat(toAdd);
      if (records.length > MAX_RECORDS) {
        records = records.slice(records.length - MAX_RECORDS);
      }
      chrome.storage.local.set({ [STORAGE_KEY]: records });
    });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush();
    }, 300);
  }

  function addRecord(record) {
    buffer.push(record);
    scheduleFlush();
  }

  // ── injected.js からの通信記録を受信 ──
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__wgi__ !== true) return;
    if (data.kind === 'network') {
      addRecord(Object.assign({ recordType: 'network' }, data.entry));
    }
  });

  // ── DOM監視: カレンダー描画部分の outerHTML スナップショットを記録 ──
  // intra-mart のカレンダーは #calendar-main 配下にAjaxで描画されるため、
  // その要素(見つからない場合は body 全体)を対象にする。
  var domSnapshotTimer = null;
  var lastSnapshotHash = '';

  function simpleHash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return h;
  }

  function takeDomSnapshot(reason) {
    var target =
      document.getElementById('calendar-main') ||
      document.getElementById('iac-container') ||
      document.body;
    if (!target) return;
    var html = target.outerHTML || '';
    var hash = simpleHash(html);
    if (hash === lastSnapshotHash) return; // 変化なしなら記録しない
    lastSnapshotHash = hash;
    addRecord({
      recordType: 'dom-snapshot',
      type: 'dom-snapshot',
      reason: reason,
      targetId: target.id || '(body)',
      pageUrl: location.href,
      ts: Date.now(),
      html: html.length > 500000 ? html.slice(0, 500000) + '...(truncated)' : html,
      htmlLength: html.length,
    });
  }

  function scheduleDomSnapshot(reason) {
    if (domSnapshotTimer) clearTimeout(domSnapshotTimer);
    domSnapshotTimer = setTimeout(function () {
      takeDomSnapshot(reason);
    }, 800); // 描画が落ち着くまで待つ(デバウンス)
  }

  function startObserving() {
    // 初回スナップショット
    scheduleDomSnapshot('initial');

    var observer = new MutationObserver(function () {
      scheduleDomSnapshot('mutation');
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
    });

    addRecord({
      recordType: 'network',
      type: 'wgi-dom-observer-started',
      method: '',
      url: location.href,
      pageUrl: location.href,
      ts: Date.now(),
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startObserving();
  } else {
    document.addEventListener('DOMContentLoaded', startObserving);
  }

  // ページを離れる直前にバッファを確実にフラッシュする
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
})();
