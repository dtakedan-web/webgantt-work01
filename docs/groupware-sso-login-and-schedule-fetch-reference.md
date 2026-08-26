# 社内グループウェア（intra-mart）SSO自動ログイン〜スケジュール取得 技術リファレンス

- 作成日: 2026-08-25
- 目的: WebGantt向けに開発した「webgantt-groupware-importer」ブラウザ拡張機能で実証済みの、
  **Windows統合認証（SSO）による自動ログイン〜スケジュール情報取得までの技術情報**を、
  **WebGanttとは無関係の別ツール**でも再利用できるよう、汎用的な技術リファレンスとして独立させたもの。
- 位置づけ: 本ドキュメントは「作成のきっかけ」を記録するための資料であり、WebGantt固有の実装
  （タスク変換・プロジェクト管理・サーバー送信等）には触れない。**ログイン〜生データ取得までの
  部分だけ**を抽出している。
- 出典（詳細版・WebGantt固有の実装を含む）: `docs/groupware-schedule-import-design.md`
  （特に2節・5節・6節・16節）

---

## 1. 対象システムの概要

- 製品名: **intra-mart Accel Collaboration**（NTTデータ社製グループウェア）
- 想定環境: **社内LAN限定**。Windowsドメイン参加済みの社内PCからのみアクセス可能
- 主要ホスト（実例。別環境では当然ホスト名が異なる）:
  - `http://suzumo.local/gwlogin` — SSOログイン用の別ドメイン（ASP.NET/IIS基盤、Windows統合認証の入口）
  - `http://imap01.suzumo.local/imart/` — intra-mart本体（ログイン後のセッションで各種APIを呼び出す対象）
- 実現したい要件: **ID・パスワードを一切保存・入力せずに、プログラム（ブラウザ拡張機能）から
  自動的にログインし、ログインユーザーのスケジュール情報を取得する**

---

## 2. 認証方式の調査経緯（背景・なぜこの方式に至ったか）

### 2.1 最初に検討して断念した方式

| 案 | 内容 | 断念理由 |
|---|---|---|
| Content Script注入方式 | 開いているintra-martタブのDOMを直接読み取る | 社内でIEモード（Trident/MSHTML）表示されるページが存在する可能性があり、Content Script/DevTools系APIの動作が保証されないため、Edgeでの実現性に大きな疑問があった |
| 管理部門への依頼 | API連携用アカウントの正式発行を依頼する | 運用上「管理部門への依頼は不可能」という制約があった（今回のケース固有の事情だが、一般的にも正規ルートが使えないケースはある） |
| フォーム型ログイン（`/imart/login`への通常ログイン） | ID/パスワードをフォームPOSTする | CSRFトークン（`im_login_info`, `im_page_key`, `im_secure_token`）の事前取得・送信が必要で複雑。かつID/パスワードの保存が必要になり本要件（保存不要）に反する |

### 2.2 採用した方式: 「拡張機能自身が裏側で直接HTTP通信する」+ Windows統合認証（SSO）

**核心のアイデア**: 「タブに何かを注入する」のではなく、拡張機能（または任意のプログラム）の
`fetch()`処理自身が、**ブラウザ標準のネットワークスタック（NTLM/Windows統合認証を含む）を
素通しで利用して**、直接グループウェアサーバーと通信する。

この方式であれば、開いているタブがIEモードかどうかは一切関係なく、また拡張機能に限らず
「ブラウザのCookieJar・認証コンテキストを利用できる実行環境」であれば同様に成立する。

**重要な発見**:
1. SSO専用の別ドメイン（`http://suzumo.local/gwlogin`）にアクセスすると、**Windowsのドメインログイン
   情報を使ってユーザーを自動判定**し、グループウェア本体への自動ログインURLへ**多段リダイレクト**する
2. この一連のリダイレクトは、`fetch(url, {credentials: 'include', redirect: 'follow'})`だけで
   **自動的に完結**し、リクエスト内にID・パスワードを一切含める必要がない
   （ブラウザ・OSのNTLM処理が裏側で自動的にWindowsログイン情報を使って認証しているため）
3. Chrome・Edge**両方の実機**で、①SSOログイン確立 → ②ホーム画面取得（ログイン成功判定） →
   ③スケジュールAPI取得、の3ステップすべてが成功することを確認済み

**結論**: Windows統合認証を利用したSSO自動ログインは、IEモードの制約を一切受けず、
かつID・パスワードを一切保存する必要がない、非常にシンプルで安全な認証方式である。

---

## 3. ログインフローの技術仕様（3段階リダイレクト）

拡張機能（または任意のHTTPクライアント）は、以下の3段階のHTTPリクエストを
`fetch(url, {credentials:'include', redirect:'follow'})`で実行するだけで、
グループウェアへのログインが完結する。

| # | リクエスト | レスポンス | 備考 |
|---|---|---|---|
| ① | `GET http://<SSO用ドメイン>/gwlogin` | `301` → `Location: http://<SSO用ドメイン>/gwlogin/`（レスポンスヘッダーに`persistent-auth: true`, `server: Microsoft-IIS/10.0`, `x-powered-by: ASP.NET`） | ASP.NET/IIS基盤。ID/パスワードは一切送信しない |
| ② | `GET http://<SSO用ドメイン>/gwlogin/` | `302` → `Location: http://<グループウェア本体ドメイン>/imart/certification?im_user=<ユーザーID>&im_password=<パスワード的な値>` | Cookieは`ASP.NET_SessionId=...`のみ送信。**ID/パスワードはリクエストに一切含まれない**。Windows統合認証（NTLM）によりサーバー側がユーザーを自動判定し、リダイレクト先URLのクエリパラメータに埋め込んで返す |
| ③ | `GET http://<グループウェア本体ドメイン>/imart/certification?im_user=...&im_password=...` | `200 OK`、`Set-Cookie: jp.co.intra_mart.session.cookie=...; path=/imart; HttpOnly` + `Set-Cookie: JSESSIONID=...; path=/` | グループウェア側のログイン処理エンドポイント。以降のAPI呼び出しはこのCookieで認証される |

### 3.1 実装上の重要ポイント

- `fetch()`の`redirect: 'follow'`（デフォルト）により、①→②→③は**1回のfetch呼び出しで
  自動的に完結**する。個別にリダイレクトを解釈する処理は不要
- ①②③のいずれにもID・パスワードをクライアント側で生成・保存・送信する処理は**存在しない**。
  **Windows統合認証（NTLM）による自動判定結果がリダイレクトURLに反映される**という、
  社内ドメイン参加PC特有の仕組みをそのまま利用している
- ログイン成功の判定根拠: ログイン確立後に`GET http://<本体>/imart/home`等を取得すると、
  レスポンス本文に特定のタイトルタグ（例:`<title>ポータル</title>`）が含まれることを確認して
  判定する、という手法も有効（本体側の任意の認証必須ページで代用可能）

### 3.2 サンプルコード（ブラウザ拡張機能 popup.js内、概念コード）

```javascript
const GWLOGIN_URL = 'http://<SSO用ドメイン>/gwlogin';

async function ensureSsoLogin() {
  const resp = await fetch(GWLOGIN_URL, {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
  });
  // resp.ok であれば、この時点でグループウェア用のセッションCookieが
  // 本体ドメインに発行されている（chrome.cookies.getAllで確認可能）
  if (!resp.ok) {
    throw new Error('SSOログインに失敗しました（status: ' + resp.status + '）。社内LANに接続されているか確認してください');
  }
  return true;
}
```

### 3.3 Manifest V3での必要権限（Chrome拡張機能の場合）

```json
{
  "permissions": ["storage", "cookies"],
  "host_permissions": [
    "http://<SSO用ドメイン>/*",
    "http://<グループウェア本体ドメイン>/*"
  ]
}
```

- `host_permissions`に、SSO用ドメインとグループウェア本体ドメインの**両方**が必要
  （ドメインが異なるため）
- `permissions: ["cookies"]`は必須ではないが、デバッグ・状態確認のために保持すると良い

---

## 4. スケジュール取得APIの仕様（`find_group_week`）

ログイン確立後（3節のCookieが有効な状態）、以下のAPIでスケジュール情報を取得できる。
これはintra-martの「グループスケジュール（週表示）」画面が内部的に呼び出しているAPIであり、
**画面のスクレイピングではなく、その裏側で使われているJSON APIを直接呼び出す**方式である。

### 4.1 エンドポイント・リクエスト仕様

```
POST http://<グループウェア本体ドメイン>/imart/collaboration/schedule/user/calendar/find_group_week
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
X-jp-co-intra-mart-ajax-request-from-imui-form-util: true
Cookie: jp.co.intra_mart.session.cookie=...; JSESSIONID=...
```

リクエストボディ（Payload）:

```
view=groupWeek&displayDate=YYYYMMDD&target=&page=1
```

| パラメータ | 説明 |
|---|---|
| `view` | 固定値 `groupWeek` |
| `displayDate` | 対象週の**日曜日**の日付（`YYYYMMDD`形式）。**未指定（空欄）の場合は今週が対象**。前後の週を取得する場合は±7日ずつ変更して複数回呼び出す |
| `target` | 空欄でよい（デフォルトのグループ表示設定が使われる） |
| `page` | 固定値 `1` |

- 複数週分を取得したい場合は、`displayDate`を基準週の日曜日から±7日ずつ変えて、
  本APIを複数回呼び出せばよい

### 4.2 レスポンス構造

```json
{
  "error": false,
  "data": {
    "schedules": [
      [ /* ユーザー1の予定オブジェクト配列 */ ],
      [ /* ユーザー2の予定オブジェクト配列 */ ],
      ...
    ],
    "title": "グループスケジュール yyyy/mm/dd - yyyy/mm/dd",
    "dayInfos": { ... }
  }
}
```

**重要な注意点**: `schedules`は「**ユーザー単位の配列の配列**」である。複数人が参加する
予定（会議）は、参加者全員の配列に**重複して出現**するため、後述の`scheduleKey.code`に
よるユニーク化が必須である。

### 4.3 予定オブジェクトの主要フィールド

| フィールド | 説明 |
|---|---|
| `title` | 予定タイトル |
| `start` / `end` | ISO8601形式の開始・終了日時 |
| `eventDate` | 終日予定の対象日 |
| `allDay` | 終日予定かどうか（`true`/`false`） |
| `scheduleKey.code` | 予定の一意キー（**重複排除に使用。必須**） |
| `type` | `"EVENT"`（個人の終日予定・勤怠系）または`"SCHEDULE"`（会議・打ち合わせ） |
| `targetInfo.name` / `targetInfo.code` | この配列がどのユーザーの予定であるかを示す氏名・コード |
| `registerUserCd` / `registerUserName` | 予定の登録者 |
| `reserveFacility` | 予約された会議室名等（`SCHEDULE`の場合に入ることがある） |
| `startDateString` / `endDateString` | `["yyyy/mm/dd", "H:mm"]`形式の配列 |
| `participants` / `joinUser` / `joinUserCounts` | 参加者情報 |
| `place` / `description` | 場所・詳細メモ |

### 4.4 予定typeの分類（実データで確認済み）

| type | 意味 | allDay | 例 |
|---|---|---|---|
| `EVENT` | 個人の終日予定（勤怠系） | `true` | フレックス、有給、夏季休暇、全日休暇 |
| `SCHEDULE` | 会議・打ち合わせ | `false`（時刻指定あり） | 定例会、打ち合わせ 等 |

---

## 5. データ加工ロジック（取得後の共通処理）

以下のロジックはグループウェア固有の癖に対応するためのもので、別ツールでも
ほぼそのまま流用できる可能性が高い（用途によって除外条件・結合条件のカスタマイズは必要）。

### 5.1 ユニーク化（重複排除）

`schedules`はユーザー単位配列の配列であり、複数人参加の予定は複数の配列に重複出現する。
`scheduleKey.code`をキーとして重複を除去する。

```javascript
function uniqueSchedules(schedulesArrays) {
  const seen = new Map();
  schedulesArrays.forEach(function (userArray) {
    if (!Array.isArray(userArray)) return;
    userArray.forEach(function (record) {
      const key = (record.scheduleKey && record.scheduleKey.code)
        ? record.scheduleKey.code
        : (record.type + '\u0000' + record.title + '\u0000' + (record.start || record.eventDate) + '\u0000' + Math.random());
      if (!seen.has(key)) seen.set(key, record);
    });
  });
  return Array.from(seen.values());
}
```

### 5.2 除外ルール（用途固有・カスタマイズ前提）

WebGanttでの実装例: タイトルに特定キーワード（例:「フレックス」）を含む終日予定を除外。
除外キーワードは配列で持ち、将来拡張可能にしておく。

```javascript
const EXCLUDED_ALLDAY_KEYWORDS = ['フレックス']; // 用途に応じて変更・追加
function isExcludedAllDayEvent(record) {
  if (record.type !== 'EVENT' || record.allDay !== true) return false;
  const title = String(record.title || '');
  return EXCLUDED_ALLDAY_KEYWORDS.some(function (kw) { return title.indexOf(kw) !== -1; });
}
```

### 5.3 連続日結合ロジック（営業日ベース）

同じ担当者・同じタイトルの終日予定が複数日連続して存在する場合（1レコードで複数日にまたがる
ケースと、日毎に別レコードとして存在するケースの両方に対応）、1本の連続タスクにまとめる。
判定は**暦日ベースではなく営業日ベース**（土日を挟んでも連続とみなす。金曜→翌週月曜も連続）。

```javascript
function isNextBusinessDay(prevIso, nextIso) {
  const parseIsoDate = (iso) => { const [y,m,d]=iso.split('-').map(Number); return new Date(y,m-1,d); };
  const prev = parseIsoDate(prevIso);
  const next = parseIsoDate(nextIso);
  const diffDays = Math.round((next - prev) / (1000*60*60*24));
  if (diffDays <= 0) return false;
  if (diffDays === 1) return true;
  const prevDow = prev.getDay(); // 0=日,...,5=金,6=土
  if (prevDow === 5 && diffDays === 3) {
    const mid1 = new Date(prev); mid1.setDate(mid1.getDate()+1);
    const mid2 = new Date(prev); mid2.setDate(mid2.getDate()+2);
    if (mid1.getDay() === 6 && mid2.getDay() === 0) return true; // 間が土・日のみ
  }
  // 祝日等、土日以外の休みを挟むケースは非対応（必要なら祝日リストを追加で考慮する）
  return false;
}
```

結合処理全体の流れ:
1. 各予定を「担当者＋タイトル」でグループ化
2. 該当する全日付を1日単位に展開してユニーク化・日付昇順ソート
3. 隣接する日付同士に`isNextBusinessDay()`を適用し、連続していれば範囲を延長、
   連続していなければ区切って新しい範囲として扱う
4. 会議（`SCHEDULE`）にはこの結合ロジックを適用しない（1件ずつ個別に扱う）

### 5.4 週境界をまたぐ結合の注意点

複数週分のデータを取得する場合は、**週ごとに個別処理せず、全週分を連結してから
一括でユニーク化・結合処理を行う**こと。そうしないと、週の境界（例: 金曜と翌週月曜）を
またぐ連続予定が正しく1本に結合されない。

---

## 6. Manifest V3 ブラウザ拡張機能としての全体構成例

実証済みの構成（WebGantt向け実装での例。別ツールでもこの構成をそのまま踏襲可能）:

```
manifest.json   — permissions/host_permissionsの定義（3.3節）
popup.html/js   — ポップアップUI本体。ログイン→取得→加工→表示の一連の処理を実行
options.html/js — 設定画面（別ツールの用途に応じて必要な設定項目を配置）
common.js       — 日付ユーティリティ・ユニーク化・除外・結合ロジック（5節）を
                  window直下に関数として提供する非モジュール形式のスクリプト
```

- `fetch()`によるHTTP通信は、`credentials: 'include'`を指定すれば、ブラウザの
  CookieJar（Windows統合認証で発行された認証情報を含む）が自動的に使われる。
  拡張機能側でCookieを明示的に読み書きする必要は基本的にない
- Content Script（ページへのJS注入）は一切不要。ポップアップ内の`fetch()`だけで完結する
- ログイン確立後のセッションは、ブラウザの通常のCookie有効期限に従う（拡張機能側で
  セッション管理する必要はない。都度`gwlogin`にアクセスし直せば再ログインも自動的に行われる）

---

## 7. 実機検証で確認済みの事実（再掲・要点）

1. `GET http://<SSO用ドメイン>/gwlogin` → `301` → `Location: .../gwlogin/`
2. `GET http://<SSO用ドメイン>/gwlogin/` → `302` → `Location: http://<本体>/imart/certification?im_user=...&im_password=...`（ID/パスワードはリクエストに含まれず、Windows統合認証による自動判定結果のみ）
3. `GET .../certification?...` → `200 OK` + セッションCookie発行
4. ログイン確立後、`GET http://<本体>/imart/home`等でログイン成功を確認可能
5. `POST .../find_group_week`（`displayDate`未指定）→ 今週分のスケジュールJSON取得成功
6. `POST .../find_group_week`（`displayDate`指定）→ 指定週分のスケジュールJSON取得成功
7. **Chrome・Edge両方の実機**で、上記フル一連の流れが成功することを確認済み

---

## 8. 別ツールへの転用時の注意点・カスタマイズポイント

- **ホスト名・ドメイン名**: 上記はすべて実例（`suzumo.local`, `imap01.suzumo.local`）。
  新しい環境では、SSO用ドメイン・グループウェア本体ドメインを事前に特定する調査が必要
  （社内ネットワーク管理者への確認、またはブラウザの開発者ツールでのネットワーク調査等）
- **APIエンドポイントの違い**: `find_group_week`はintra-martの「グループスケジュール週表示」
  専用API。別の画面・別の情報を取得したい場合は、対象画面がどのAPIを呼び出しているか、
  ブラウザ開発者ツールのNetworkタブで別途調査が必要（本ツール開発時と同様の手法で解明可能）
- **平文HTTP通信について**: 本リファレンスの通信例はすべて`http://`（平文）。これは
  「社内LAN限定のシステムであるため問題ない」というWebGantt側での判断に基づくものであり、
  別ツールで採用する場合は各自の環境・セキュリティポリシーに応じて再検討すること
- **利用ポリシーについて**: Windows統合認証を「借用」する形の自動ログインは、intra-mart側の
  正規のログイン手順を経ずにアクセスするものではなく、通常のブラウザアクセスと同じ認証経路を
  通るものだが、社内システムの利用ポリシーに抵触しないか、各自の判断・責任で確認すること
- **除外ルール・結合ルールのカスタマイズ**: 5.2節・5.3節のロジックはWebGantt固有の要件
  （フレックス除外、営業日ベース結合）に基づくものであり、別ツールの用途に応じて
  条件を変更・削除・追加する前提で参考にすること

---

## 9. 参考: 本リファレンスの元になった実装ファイル（WebGantt側、参照用）

- `browser-extension/webgantt-groupware-importer/manifest.json` — 権限設定
- `browser-extension/webgantt-groupware-importer/popup.js` — ログイン〜取得〜加工の呼び出し順序
- `browser-extension/webgantt-groupware-importer/common.js` — 日付ユーティリティ・ユニーク化・除外・結合ロジックの実装本体
- `docs/groupware-schedule-import-design.md` — 詳細設計書（WebGantt固有のタスク変換・サーバー送信部分を含む完全版）

これらのファイル自体はWebGanttリポジトリに属するものであり、別ツールのリポジトリには
含めない。本リファレンスに転記したコード・仕様のみを参考情報として利用すること。
