// WebGantt Groupware SSO PoC
// 目的: Chrome拡張機能のfetch()から、社内グループウェア(intra-mart)へのSSO自動ログイン
//       (suzumo.local/gwlogin 経由のWindows統合認証リダイレクト)が実際に成立するかどうか、
//       またログイン後にスケジュールAPI(find_group_week)が取得できるかどうかを検証する。
// 本体機能(gantt-collab.html)には一切関与しない、独立した使い捨て検証コード。

const GWLOGIN_URL = 'http://suzumo.local/gwlogin';
const IMART_HOME_URL = 'http://imap01.suzumo.local/imart/home';
const IMART_FIND_GROUP_WEEK_URL =
  'http://imap01.suzumo.local/imart/collaboration/schedule/user/calendar/find_group_week';
const IMART_COOKIE_DOMAIN = 'imap01.suzumo.local';

const els = {
  btnStep1: document.getElementById('btnStep1'),
  btnStep2: document.getElementById('btnStep2'),
  btnStep3: document.getElementById('btnStep3'),
  step1Status: document.getElementById('step1Status'),
  step2Status: document.getElementById('step2Status'),
  step3Status: document.getElementById('step3Status'),
  step1Result: document.getElementById('step1Result'),
  step2Result: document.getElementById('step2Result'),
  step3Result: document.getElementById('step3Result'),
  payloadInput: document.getElementById('payloadInput'),
  log: document.getElementById('log'),
};

function log(msg) {
  const ts = new Date().toLocaleTimeString('ja-JP');
  els.log.textContent += `[${ts}] ${msg}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status ${kind || ''}`.trim();
}

function showResult(el, text) {
  el.style.display = 'block';
  el.textContent = text;
}

function truncate(str, max) {
  if (str == null) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + `\n...(以下省略、全${s.length}文字)` : s;
}

async function getImartCookies() {
  if (!chrome.cookies) return [];
  try {
    const cookies = await chrome.cookies.getAll({ domain: IMART_COOKIE_DOMAIN });
    return cookies;
  } catch (e) {
    log(`chrome.cookies.getAll エラー: ${e.message}`);
    return [];
  }
}

// ---- Step 1: SSOログイン確認 ----
els.btnStep1.addEventListener('click', async () => {
  els.btnStep1.disabled = true;
  setStatus(els.step1Status, '実行中...', 'wait');
  els.step1Result.style.display = 'none';
  log(`Step1: ${GWLOGIN_URL} へアクセス開始`);

  try {
    const res = await fetch(GWLOGIN_URL, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
    });

    const bodyText = await res.text().catch(() => '(本文読み取り失敗)');
    const cookiesAfter = await getImartCookies();
    const cookieNames = cookiesAfter.map((c) => c.name);
    const hasSessionCookie = cookieNames.includes('jp.co.intra_mart.session.cookie');
    const hasJsessionId = cookieNames.includes('JSESSIONID');

    const summary = [
      `最終URL: ${res.url}`,
      `redirected: ${res.redirected}`,
      `status: ${res.status} ${res.statusText}`,
      `ok: ${res.ok}`,
      '',
      `imap01.suzumo.local のCookie一覧: ${cookieNames.join(', ') || '(なし)'}`,
      `jp.co.intra_mart.session.cookie 発行: ${hasSessionCookie ? 'YES' : 'NO'}`,
      `JSESSIONID 発行: ${hasJsessionId ? 'YES' : 'NO'}`,
      '',
      '--- レスポンス本文(先頭) ---',
      truncate(bodyText, 400),
    ].join('\n');
    showResult(els.step1Result, summary);

    if (hasSessionCookie && hasJsessionId) {
      setStatus(els.step1Status, '✅ 成功: SSOログイン確立(Cookie発行を確認)', 'ok');
      els.btnStep2.disabled = false;
      els.btnStep3.disabled = false;
      log('Step1: 成功。intra-martの認証Cookieが発行されました。');
    } else {
      setStatus(
        els.step1Status,
        '⚠️ 判定不能: レスポンスは取得できましたが、想定するCookieが見つかりません',
        'ng'
      );
      log('Step1: Cookie未発行。ログインが完了していないか、ドメイン/パス指定が想定と異なる可能性があります。');
      // Cookie判定がNGでも、レスポンス自体は取れているので手動確認できるよう次のボタンは開放する
      els.btnStep2.disabled = false;
      els.btnStep3.disabled = false;
    }
  } catch (e) {
    setStatus(els.step1Status, `❌ 失敗: ${e.message}`, 'ng');
    showResult(els.step1Result, `エラー詳細:\n${e.stack || e.message}`);
    log(`Step1: 例外発生 - ${e.message}`);
  } finally {
    els.btnStep1.disabled = false;
  }
});

// ---- Step 2: ホーム画面アクセス確認 ----
els.btnStep2.addEventListener('click', async () => {
  els.btnStep2.disabled = true;
  setStatus(els.step2Status, '実行中...', 'wait');
  els.step2Result.style.display = 'none';
  log(`Step2: ${IMART_HOME_URL} へアクセス開始`);

  try {
    const res = await fetch(IMART_HOME_URL, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
    });
    const bodyText = await res.text().catch(() => '(本文読み取り失敗)');
    const looksLikeHome = /<title>\s*ポータル\s*<\/title>/.test(bodyText);
    const looksLikeLoginPage = /im_user|im_password|imui-login-form/.test(bodyText);

    const summary = [
      `最終URL: ${res.url}`,
      `redirected: ${res.redirected}`,
      `status: ${res.status} ${res.statusText}`,
      `<title>ポータル</title> を検出: ${looksLikeHome ? 'YES(ホーム画面らしい)' : 'NO'}`,
      `ログイン画面の要素を検出: ${looksLikeLoginPage ? 'YES(未ログインの可能性)' : 'NO'}`,
      '',
      '--- レスポンス本文(先頭) ---',
      truncate(bodyText, 400),
    ].join('\n');
    showResult(els.step2Result, summary);

    if (looksLikeHome && !looksLikeLoginPage) {
      setStatus(els.step2Status, '✅ 成功: ホーム画面を取得できました', 'ok');
      log('Step2: 成功。ホーム画面のHTMLを取得できました。');
    } else if (looksLikeLoginPage) {
      setStatus(els.step2Status, '❌ 失敗: ログイン画面が返されました(未ログイン状態)', 'ng');
      log('Step2: ログイン画面が返却されました。Step1のログインが有効になっていない可能性があります。');
    } else {
      setStatus(els.step2Status, '⚠️ 判定不能: 想定外のレスポンスです(下記本文を確認してください)', 'ng');
      log('Step2: ホーム画面/ログイン画面のいずれの特徴も検出できませんでした。');
    }
  } catch (e) {
    setStatus(els.step2Status, `❌ 失敗: ${e.message}`, 'ng');
    showResult(els.step2Result, `エラー詳細:\n${e.stack || e.message}`);
    log(`Step2: 例外発生 - ${e.message}`);
  } finally {
    els.btnStep2.disabled = false;
  }
});

// ---- Step 3: スケジュールAPI確認 ----
els.btnStep3.addEventListener('click', async () => {
  els.btnStep3.disabled = true;
  setStatus(els.step3Status, '実行中...', 'wait');
  els.step3Result.style.display = 'none';

  const payload = els.payloadInput.value.trim();
  log(`Step3: ${IMART_FIND_GROUP_WEEK_URL} へPOST開始 (payload: ${payload || '(空)'})`);

  try {
    const res = await fetch(IMART_FIND_GROUP_WEEK_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-jp-co-intra-mart-ajax-request-from-imui-form-util': 'true',
      },
      body: payload,
    });

    const rawText = await res.text().catch(() => '(本文読み取り失敗)');
    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      parseError = e.message;
    }

    let summaryLines = [
      `status: ${res.status} ${res.statusText}`,
      `content-type: ${res.headers.get('content-type') || '(不明)'}`,
      '',
    ];

    if (parsed && parsed.data && Array.isArray(parsed.data.schedules)) {
      const perUserCounts = parsed.data.schedules.map((arr) => arr.length);
      summaryLines.push(`JSON解析: 成功`);
      summaryLines.push(`error: ${parsed.error}`);
      summaryLines.push(`title: ${parsed.data.title || '(なし)'}`);
      summaryLines.push(`ユーザー数(schedules配列の数): ${parsed.data.schedules.length}`);
      summaryLines.push(`各ユーザーの予定件数: [${perUserCounts.join(', ')}]`);
      setStatus(els.step3Status, '✅ 成功: スケジュールデータを取得できました', 'ok');
      log(`Step3: 成功。ユーザー数=${parsed.data.schedules.length}, 予定件数=[${perUserCounts.join(',')}]`);
    } else {
      summaryLines.push(`JSON解析: ${parseError ? '失敗 - ' + parseError : '想定した構造ではありません'}`);
      setStatus(els.step3Status, '⚠️ 想定と異なるレスポンスです', 'ng');
      log('Step3: 想定したJSON構造(data.schedules)が見つかりませんでした。');
    }

    summaryLines.push('', '--- レスポンス本文(先頭) ---', truncate(rawText, 800));
    showResult(els.step3Result, summaryLines.join('\n'));
  } catch (e) {
    setStatus(els.step3Status, `❌ 失敗: ${e.message}`, 'ng');
    showResult(els.step3Result, `エラー詳細:\n${e.stack || e.message}`);
    log(`Step3: 例外発生 - ${e.message}`);
  } finally {
    els.btnStep3.disabled = false;
  }
});

log('検証用PoCポップアップを開きました。まず①のボタンから順にお試しください。');
