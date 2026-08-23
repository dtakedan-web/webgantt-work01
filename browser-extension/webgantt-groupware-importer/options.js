/**
 * WebGantt Groupware Importer — オプション画面（初回設定）
 * 参照: docs/groupware-schedule-import-design.md 10.1節・11.2節
 *
 * Teams Excel連携の options.js とほぼ同一パターンだが、本機能は
 * intra-martへのアクセスをWindows統合認証（SSO）で自動的に行うため、
 * 共有リンク等の追加設定項目は存在しない（トークンのみ）。
 *
 * 【2026-08-23追記】保存時接続テストを追加。
 * 「初回設定時にトークンを間違えて保存してしまい、ポップアップで接続に失敗する
 * 状態になっても解除できない」という問題への対応（ユーザー要望）。
 * 保存ボタン押下時に以下を確認し、いずれかに失敗した場合は
 * chrome.storage.local.set を呼ばず、既存の保存済み値をそのまま保持する。
 *   1. token_verify API でトークンの有効性を確認
 *   2. gwlogin への疎通確認（Windows統合認証によるSSO自動ログイン）
 */

const SERVER_BASE = 'https://ogma.mydns.jp/WebGantt';
const API_ENDPOINT = SERVER_BASE + '/api/groupware_schedule_import.php';
const GWLOGIN_URL = 'http://suzumo.local/gwlogin';

document.addEventListener('DOMContentLoaded', function () {
  chrome.storage.local.get(['wggToken'], function (data) {
    if (data.wggToken) document.getElementById('tokenInput').value = data.wggToken;
  });
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
});

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'message ' + (type || 'info');
}

function setBusy(busy) {
  const btn = document.getElementById('saveBtn');
  btn.disabled = busy;
}

async function saveSettings() {
  const token = document.getElementById('tokenInput').value.trim();

  if (!token || !token.startsWith('gws_')) {
    showMsg('トークンの形式が正しくないようです（"gws_"で始まる文字列を貼り付けてください）', 'error');
    return;
  }

  setBusy(true);
  showMsg('接続確認をしています…（トークン確認 → 社内グループウェアSSO疎通確認）', 'info');

  try {
    // 1. トークンの有効性確認
    let res;
    try {
      res = await fetch(API_ENDPOINT + '?action=token_verify', {
        headers: { Authorization: 'Bearer ' + token },
      });
    } catch (err) {
      throw new Error('WebGantt サーバーに接続できませんでした（通信エラー）: ' + err.message);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data.error ? '（' + data.error + '）' : '';
      } catch (e) { /* ignore */ }
      throw new Error('トークンが無効です' + detail + '。account.htmlで再発行したトークンを貼り付けてください');
    }

    // 2. 社内グループウェア（intra-mart）SSO疎通確認
    let loginRes;
    try {
      loginRes = await fetch(GWLOGIN_URL, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
      });
    } catch (err) {
      throw new Error('社内グループウェアへの接続に失敗しました（通信エラー）: ' + err.message + '。社内LANに接続されているか確認してください');
    }
    if (!loginRes.ok) {
      throw new Error('社内グループウェアへのログインに失敗しました（status: ' + loginRes.status + '）。社内LANに接続されているか確認してください');
    }

    // すべて成功した場合のみ保存する
    await new Promise(function (resolve) {
      chrome.storage.local.set({ wggToken: token }, resolve);
    });
    showMsg('接続確認に成功し、設定を保存しました。ポップアップを開いて動作確認してください', 'success');
  } catch (err) {
    // 接続確認に失敗した場合は保存を行わず、既存の保存済み値を保持する
    showMsg('接続確認に失敗したため保存しませんでした（既存の設定はそのまま残っています）:\n' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}
