/**
 * WebGantt グループウェア調査ツール - popup.js
 * 記録件数の表示、JSONダウンロード、記録クリアを行う。
 */
const STORAGE_KEY = 'wgi_records';

const recordCountEl = document.getElementById('recordCount');
const networkCountEl = document.getElementById('networkCount');
const domCountEl = document.getElementById('domCount');
const msgEl = document.getElementById('msg');
const downloadBtn = document.getElementById('downloadBtn');
const refreshBtn = document.getElementById('refreshBtn');
const clearBtn = document.getElementById('clearBtn');

function showMsg(text, isError) {
  msgEl.textContent = text;
  msgEl.className = isError ? 'error' : '';
}

function loadRecords() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      resolve((res && res[STORAGE_KEY]) || []);
    });
  });
}

async function refreshStats() {
  const records = await loadRecords();
  recordCountEl.textContent = String(records.length);
  networkCountEl.textContent = String(
    records.filter((r) => r.recordType === 'network').length
  );
  domCountEl.textContent = String(
    records.filter((r) => r.recordType === 'dom-snapshot').length
  );
}

async function onDownloadClick() {
  const records = await loadRecords();
  if (records.length === 0) {
    showMsg('記録がまだありません。カレンダー画面を開いて操作してから再度お試しください。', true);
    return;
  }
  const payload = {
    exportedAt: new Date().toISOString(),
    recordCount: records.length,
    records: records,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const filename = `wgi_records_${Date.now()}.json`;
  chrome.downloads.download(
    { url: url, filename: filename, saveAs: false },
    (downloadId) => {
      if (chrome.runtime.lastError) {
        showMsg('ダウンロードに失敗しました: ' + chrome.runtime.lastError.message, true);
      } else {
        showMsg(`ダウンロードしました: ${filename}`);
      }
    }
  );
}

async function onClearClick() {
  await new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: [] }, resolve);
  });
  showMsg('記録をクリアしました。');
  await refreshStats();
}

downloadBtn.addEventListener('click', onDownloadClick);
refreshBtn.addEventListener('click', () => {
  refreshStats();
  showMsg('件数を更新しました。');
});
clearBtn.addEventListener('click', onClearClick);

refreshStats();
