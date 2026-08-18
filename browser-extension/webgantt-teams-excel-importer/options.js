/**
 * WebGantt Teams Excel Importer — オプション画面（初回設定）
 * 参照: docs/teams-excel-import-design.md 7.1節・8.1節
 */

document.addEventListener('DOMContentLoaded', function () {
  chrome.storage.local.get(['wgtToken', 'wgtShareUrl'], function (data) {
    if (data.wgtToken) document.getElementById('tokenInput').value = data.wgtToken;
    if (data.wgtShareUrl) document.getElementById('shareUrlInput').value = data.wgtShareUrl;
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
  const shareUrl = document.getElementById('shareUrlInput').value.trim();

  if (!token || !token.startsWith('tex_')) {
    showMsg('トークンの形式が正しくないようです（"tex_"で始まる文字列を貼り付けてください）', 'error');
    return;
  }
  if (!shareUrl) {
    showMsg('共有リンクを入力してください', 'error');
    return;
  }

  chrome.storage.local.set({ wgtToken: token, wgtShareUrl: shareUrl }, function () {
    showMsg('設定を保存しました。ポップアップを開いて動作確認してください', 'success');
  });
}
