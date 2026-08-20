/**
 * WebGantt グループウェア調査ツール - injected.js
 * ============================================
 * このファイルは manifest.json の設定により、ページ本体のJavaScript実行環境
 * (MAIN world)に document_start(ページの他のスクリプトが動く前)のタイミングで
 * 注入される。ページが発行する fetch / XMLHttpRequest 通信をすべて横取りして記録し、
 * window.postMessage() で同じページ内の content_bridge.js(拡張機能側の
 * ISOLATED world、chrome.storage 等にアクセスできる側)へ転送する。
 *
 * 「開発者ツールが使えない/ブロックされている」環境でも、この方式であれば
 * DevToolsを一切使わずに通信内容を記録できる。
 *
 * 【調査専用ツールについて】
 * これはWebGanttの正式な拡張機能(Teams Excel連携など)とは無関係の、
 * 社内グループウェア(intra-mart)のスケジュール機能の通信・DOM構造を調査するための
 * 一時的な診断ツール。設計調査が完了したら削除してよい。
 */
(function () {
  if (window.__wgi_injected__) return; // 二重注入防止(all_framesでの多重実行対策)
  window.__wgi_injected__ = true;

  function postLog(entry) {
    try {
      window.postMessage({ __wgi__: true, kind: 'network', entry: entry }, '*');
    } catch (e) {
      // postMessageで失敗しても、ページの動作自体には影響させない
    }
  }

  function truncate(str, maxLen) {
    if (typeof str !== 'string') return str;
    if (str.length > maxLen) {
      return str.slice(0, maxLen) + `...(truncated, total ${str.length} chars)`;
    }
    return str;
  }

  function safeStringifyBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return truncate(body, 50000);
    try {
      return truncate(JSON.stringify(body), 50000);
    } catch (e) {
      try {
        return truncate(String(body), 50000);
      } catch (e2) {
        return '(unserializable request body)';
      }
    }
  }

  // ── fetch のフック ──
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (resource, config) {
      var url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
      var method = (config && config.method) || (resource && resource.method) || 'GET';
      var startTs = Date.now();
      var reqBody = config && config.body;
      return origFetch.apply(this, arguments).then(function (response) {
        try {
          var cloned = response.clone();
          cloned
            .text()
            .then(function (text) {
              postLog({
                type: 'fetch',
                method: method,
                url: url,
                status: response.status,
                ts: startTs,
                pageUrl: location.href,
                requestBody: safeStringifyBody(reqBody),
                responseBody: truncate(text, 300000),
              });
            })
            .catch(function () {});
        } catch (e) {}
        return response;
      }).catch(function (err) {
        postLog({
          type: 'fetch-error',
          method: method,
          url: url,
          ts: startTs,
          pageUrl: location.href,
          error: String(err),
        });
        throw err;
      });
    };
  }

  // ── XMLHttpRequest のフック ──
  var OrigXHR = window.XMLHttpRequest;
  function WrappedXHR() {
    var xhr = new OrigXHR();
    var _method = '';
    var _url = '';
    var _reqBody = null;
    var origOpen = xhr.open;
    xhr.open = function (method, url) {
      _method = method;
      _url = url;
      return origOpen.apply(xhr, arguments);
    };
    var origSend = xhr.send;
    xhr.send = function (body) {
      _reqBody = body;
      xhr.addEventListener('load', function () {
        try {
          var respBody;
          var rt = xhr.responseType;
          if (!rt || rt === 'text' || rt === '') {
            respBody = xhr.responseText;
          } else if (rt === 'json') {
            respBody = JSON.stringify(xhr.response);
          } else {
            respBody = '(responseType=' + rt + ' のため未記録)';
          }
          postLog({
            type: 'xhr',
            method: _method,
            url: _url,
            status: xhr.status,
            ts: Date.now(),
            pageUrl: location.href,
            requestBody: safeStringifyBody(_reqBody),
            responseBody: truncate(String(respBody), 300000),
          });
        } catch (e) {
          postLog({
            type: 'xhr-error',
            method: _method,
            url: _url,
            ts: Date.now(),
            pageUrl: location.href,
            error: String(e),
          });
        }
      });
      return origSend.apply(xhr, arguments);
    };
    return xhr;
  }
  WrappedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = WrappedXHR;

  // 起動を知らせる合図(content_bridge.js側のログにも記録され、
  // フックが正しく効いているかどうかの目印になる)
  postLog({
    type: 'wgi-hook-installed',
    method: '',
    url: location.href,
    ts: Date.now(),
    pageUrl: location.href,
  });
})();
