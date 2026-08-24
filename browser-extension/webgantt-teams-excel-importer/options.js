/**
 * WebGantt Teams Excel Importer — オプション画面（初回設定）
 * 参照: docs/teams-excel-import-design.md 7.1節・8.1節・18節（複数フォーマット対応）
 *
 * 【2026-08-23追記】保存時接続テストを追加。
 * 「初回設定時にトークンや共有リンクを間違えて保存してしまい、ポップアップで
 * 接続に失敗する状態になっても解除できない」という問題への対応（ユーザー要望）。
 * 保存ボタン押下時に以下を確認し、いずれかに失敗した場合は
 * chrome.storage.local.set を呼ばず、既存の保存済み値をそのまま保持する。
 *   1. token_verify API でトークンの有効性を確認
 *   2. 共有リンクから推測したSharePointサイトへ currentuser API で疎通確認
 *   3. shares API で実際にファイル情報（downloadUrl）が取得できるか確認
 *
 * 【2026-08-24追記】複数フォーマット対応。「読み込むエクセル予定表フォーマット」
 * ドロップダウンを追加した。選択肢は WGT.listFormats()（common.js + formats/*.js
 * が自己登録した一覧）から動的生成する。フォーマット選択自体は接続確認の対象外
 * （フォーマットの正誤はExcel取得後でないと判断できないため、token_verify等の
 * 3段階接続テストとは独立して保存する）。1ユーザーにつきフォーマットは基本1つ
 * 固定という運用のため、初回設定画面でのみ選択する形とした。
 */

const SERVER_BASE = 'https://ogma.mydns.jp/WebGantt';
const API_ENDPOINT = SERVER_BASE + '/api/teams_excel_import.php';

document.addEventListener('DOMContentLoaded', function () {
  populateFormatSelect();
  chrome.storage.local.get(['wgtToken', 'wgtShareUrl', 'wgtFormatId'], function (data) {
    if (data.wgtToken) document.getElementById('tokenInput').value = data.wgtToken;
    if (data.wgtShareUrl) document.getElementById('shareUrlInput').value = data.wgtShareUrl;
    document.getElementById('formatSelect').value = data.wgtFormatId || WGT.DEFAULT_FORMAT_ID;
  });
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
});

/** 登録済みフォーマット一覧（WGT.listFormats()）からドロップダウンの選択肢を生成する */
function populateFormatSelect() {
  const select = document.getElementById('formatSelect');
  select.innerHTML = '';
  WGT.listFormats().forEach(function (fmt) {
    const opt = document.createElement('option');
    opt.value = fmt.id;
    opt.textContent = fmt.label;
    select.appendChild(opt);
  });
}

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
  const shareUrl = document.getElementById('shareUrlInput').value.trim();
  const formatId = document.getElementById('formatSelect').value;

  if (!formatId || !WGT.getFormat(formatId)) {
    showMsg('読み込むフォーマットを選択してください', 'error');
    return;
  }
  if (!token || !token.startsWith('tex_')) {
    showMsg('トークンの形式が正しくないようです（"tex_"で始まる文字列を貼り付けてください）', 'error');
    return;
  }
  if (!shareUrl) {
    showMsg('共有リンクを入力してください', 'error');
    return;
  }

  setBusy(true);
  showMsg('接続確認をしています…（トークン確認 → SharePoint疎通 → Excelファイル確認）', 'info');

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

    // 2. 共有リンクからサイト基点URLを推測し、SharePointへのログイン状態（currentuser）を確認
    const siteBase = WGT.extractSiteBaseUrl(shareUrl);
    if (!siteBase) {
      throw new Error('共有リンクの形式が正しく解釈できませんでした。SharePoint/OneDriveの「共有」から取得したリンクをそのまま貼り付けてください');
    }
    let meRes;
    try {
      meRes = await fetch(siteBase + '/_api/web/currentuser', {
        headers: { Accept: 'application/json;odata=nometadata' },
        credentials: 'include',
      });
    } catch (err) {
      throw new Error('SharePointへの接続に失敗しました（通信エラー）: ' + err.message);
    }
    if (!meRes.ok) {
      throw new Error('SharePointにログインしていないようです（status: ' + meRes.status + '）。ブラウザでTeams/SharePointに一度ログインしてから再度保存してください');
    }

    // 3. shares APIで実際にファイル情報（downloadUrl）が取得できるか確認
    let tenantOrigin;
    try {
      tenantOrigin = new URL(shareUrl).origin;
    } catch (err) {
      throw new Error('共有リンクのURL形式が正しくありません');
    }
    const encodedShareId = WGT.encodeSharingUrl(shareUrl);
    let sharesRes;
    try {
      sharesRes = await fetch(tenantOrigin + '/_api/v2.0/shares/' + encodedShareId + '/driveItem', {
        headers: { Accept: 'application/json;odata=nometadata' },
        credentials: 'include',
      });
    } catch (err) {
      throw new Error('Excelファイル情報の取得に失敗しました（通信エラー）: ' + err.message);
    }
    if (!sharesRes.ok) {
      throw new Error('Excelファイル情報の取得に失敗しました（status: ' + sharesRes.status + '）。共有リンクが正しいか確認してください');
    }
    const sharesData = await sharesRes.json();
    const downloadUrl = sharesData['@content.downloadUrl'] || sharesData['@microsoft.graph.downloadUrl'];
    if (!downloadUrl) {
      throw new Error('Excelファイル情報の取得に失敗しました（ダウンロードURLが取得できませんでした）。共有リンクが正しいか確認してください');
    }

    // すべて成功した場合のみ保存する
    await new Promise(function (resolve) {
      chrome.storage.local.set({ wgtToken: token, wgtShareUrl: shareUrl, wgtFormatId: formatId }, resolve);
    });
    showMsg('接続確認に成功し、設定を保存しました。ポップアップを開いて動作確認してください', 'success');
  } catch (err) {
    // 接続確認に失敗した場合は保存を行わず、既存の保存済み値を保持する
    showMsg('接続確認に失敗したため保存しませんでした（既存の設定はそのまま残っています）:\n' + err.message, 'error');
  } finally {
    setBusy(false);
  }
}
