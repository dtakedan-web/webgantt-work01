// ============================================================
// device-detect.js
// モバイル/タブレット端末判定の共通ロジック。
//
// 用途:
//   login.html の redirectToGantt() で、遷移先を
//   gantt-mobile.html / gantt-collab.html のどちらにするか判定するために使用。
//   将来的に projects.html / account.html の
//   「ガントチャートへ戻る」リンクでも同じ判定が必要になった場合、
//   このファイルを <script src="/WebGantt/collab/device-detect.js"></script>
//   で読み込むだけで isMobileOrTabletDevice() を利用できる。
//
// 判定方針（2026-08-11 ユーザー確認済み）:
//   - window幅・matchMedia等のビューポート幅は使用しない
//     （PCブラウザのウィンドウを狭めただけではモバイル判定にしない）。
//   - User-Agent文字列による端末種別判定を基本とする。
//   - iPadOS 13以降はSafariがUAを"Macintosh"と偽装するため、
//     マルチタッチ対応(navigator.maxTouchPoints > 1)を併用してiPadを検出する。
// ============================================================
(function (global) {
  'use strict';

  function isMobileOrTabletDevice() {
    var ua = global.navigator ? (global.navigator.userAgent || global.navigator.vendor || '') : '';

    // Android/iPhone/iPod等の主要モバイルOS
    if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
      return true;
    }

    // iPad（クラシックUA表記。iPadOS 12以前や「デスクトップ用Webサイトを表示」設定を外した場合）
    if (/iPad/i.test(ua)) {
      return true;
    }

    // iPadOS 13以降はUAが"Macintosh"を名乗るため、マルチタッチ対応で判定する
    if (/Macintosh/i.test(ua) && global.navigator && global.navigator.maxTouchPoints > 1) {
      return true;
    }

    return false;
  }

  global.isMobileOrTabletDevice = isMobileOrTabletDevice;
})(window);
