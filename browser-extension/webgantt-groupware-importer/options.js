/**
 * WebGantt Groupware Importer — オプション画面（初回設定）
 * 参照: docs/groupware-schedule-import-design.md 10.1節・11.2節
 *
 * Teams Excel連携の options.js とほぼ同一パターンだが、本機能は
 * intra-martへのアクセスをWindows統合認証（SSO）で自動的に行うため、
 * 共有リンク等の追加設定項目は存在しない（トークンのみ）。
 */

document.addEventListener('DOMContentLoaded', function () {
  chrome.storage.local.get(['wggToken'], function (data) {
    if (data.wggToken) document.getElementById('tokenInput').value = data.wggToken;
  });
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
});

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'message ' + type;
}

function saveSettings() {
  const token = document.getElementById('tokenInput').value.trim();

  if (!token || !token.startsWith('gws_')) {
    showMsg('トークンの形式が正しくないようです（"gws_"で始まる文字列を貼り付けてください）', 'error');
    return;
  }

  chrome.storage.local.set({ wggToken: token }, function () {
    showMsg('設定を保存しました。ポップアップを開いて動作確認してください', 'success');
  });
}
