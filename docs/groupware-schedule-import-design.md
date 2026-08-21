# 社内グループウェア（intra-mart）スケジュール連携（ブラウザ拡張機能方式）設計書

- 作成日: 2026-08-21
- ステータス: **設計調査完了・本設計書ドラフト作成。ユーザー確認待ち**
- 前提: `WebGantt開発コンテキスト.md` の全ルールに従う
  - `gantt-collab.html`（PC版）のコアUI/UXは変更しない
  - Web専用の新機能は最下バーまたは別ページに実装する
  - `#settingsPopover` には一切触れない
  - ワークフローは 設計 → ユーザー確認 → 実装 の順を厳守する
  - コアロジックの変更は Web版（本サンドボックス）にのみ反映。ローカル版（gantt-v0771.html）への反映はユーザー自身の責任
- 姉妹設計書: `docs/teams-excel-import-design.md`（ブラウザ拡張機能方式・トークン認証・サーバー直接送信方式（方式Q）・コード分離方針の出典。本設計書は同方式をほぼそのまま踏襲する）

---

## 1. 目的・概要

社内グループウェア「**intra-mart Accel Collaboration**」（NTTデータ社製、社内LAN限定、URL: `http://imap01.suzumo.local/imart/`）に登録されている**週間スケジュール（予定表）**を取得し、WebGanttのタスクとして取り込む機能を追加する。

**基本方針**: 1件の予定 = 1つのタスクとして追加する。担当者はスケジュールの所有者（`targetInfo.name`）を自動割当する。取り込み対象は、Teams Excel連携と同様に**チェックボックスで選択インポート**する形式とする。

**対象範囲（本フェーズ）**: intra-martの「グループスケジュール（週表示）」画面が内部的に呼び出しているAPI（`find_group_week`）から取得できる、ログインユーザーが所属するグループのメンバー全員分の週間予定。取得範囲は**1〜4週間**（Teams Excel連携と同様の考え方）。

**本機能の最大の特徴（Teams Excel連携との共通点・相違点）**:
- 共通点: WebGanttサーバー（PHP API）だけでは完結せず、**ユーザーのブラウザにインストールする「ブラウザ拡張機能（Manifest V3）」が必須**となる（intra-martの認証情報が社内LAN内にしか存在せず、WebGantt本番サーバー・サンドボックスのいずれからも到達不可能なため）。
- 相違点: Teams Excel連携ではSharePointの**既存ブラウザCookie**を利用したが、本機能ではさらに一段進んで、**Windows統合認証（SSO）を利用した拡張機能内での自動ログイン**を行う（2節参照）。これにより、拡張機能はID/パスワードを一切保存・入力せずに、ポップアップを開いた瞬間に自動でintra-martへログインしたうえでスケジュールを取得できる。

---

## 2. 方式検討の経緯（重要・必読）

### 2.1 出発点の懸念: 「Edgeで実現できないと効果が半減以下」

ユーザー実務ではEdgeブラウザで社内システムを利用する場面が多く、intra-martの旧UI互換のために**IEモード（Trident/MSHTML）**で表示されるページが存在する可能性が懸念された。IEモードで表示されたタブには、Chrome拡張機能のContent Script/DevTools系のAPIが正しく動作しない制約があるため、「タブに注入して情報を読み取る」方式ではEdge上での実現性に大きな疑問が残っていた。

### 2.2 断念した方式

| 案 | 内容 | 結果 |
|---|---|---|
| 案α | Content Scriptで開いているintra-martタブのDOMを読み取る方式（Teams Excel連携の旧「方式P」に近い発想） | **不採用**。IEモードで表示されている場合、Content Scriptの動作保証がなく「Edgeで実現できないと効果が半減以下」というユーザー懸念に応えられない |
| 案β | 管理部門にAPI連携やアカウント発行を依頼する正規ルート | **不採用（ユーザー制約）**。「管理部門への依頼は不可能」と明言されている |
| 案γ（調査用拡張機能） | intra-martの通信内容そのものを調査するための一時的な調査用拡張機能（`webgantt-groupware-investigator/`） | 調査完了後に**削除済み**（コミット `4a4e488`）。目的（通信内容の解明）を終えたため撤去 |

### 2.3 採用方式: 「拡張機能自身が裏側で直接HTTP通信する」方式 + Windows統合認証（SSO）自動ログイン

「タブに何かを注入する」のではなく、**拡張機能のバックグラウンド処理（popup.js内のfetch）自身が、ブラウザのCookieJarを使って直接intra-martサーバーと通信する**方式を検証した。この方式であれば、開いているタブがIEモードかどうかは一切関係なく、拡張機能の`fetch()`はブラウザ標準のネットワークスタック（NTLM/Windows統合認証を含む）を素通しで利用できる。

検証の結果、以下の重要な発見があった：

1. `http://suzumo.local/gwlogin`（intra-martとは別ドメイン、ASP.NET/IIS基盤）にアクセスすると、**Windowsのドメインログイン情報を使ってユーザーを自動判定**し、intra-martへの自動ログインURLへ多段リダイレクトすることが判明した。
2. この一連のリダイレクトは、拡張機能の`fetch(url, {credentials: 'include', redirect: 'follow'})`だけで**自動的に完結**し、リクエスト内にID・パスワードを一切含める必要がない（ブラウザ・OSのNTLM処理が裏側で自動的にWindowsログイン情報を使って認証しているため）。
3. Chrome・Edge**両方の実機**で、検証用PoC拡張機能（`webgantt-groupware-sso-poc/`、4節参照）を使い、①SSOログイン確立 → ②ホーム画面取得（`<title>ポータル</title>`確認） → ③スケジュールAPI取得（`find_group_week`のJSONレスポンス取得）の3ステップすべてが成功することを確認した。

**結論**: 「拡張機能自身が裏側で直接HTTP通信する」方式は、IEモードの制約を一切受けない。さらに、Windows統合認証によるSSOを利用することで、**拡張機能内にID・パスワードを保存する必要が一切ない**という、Teams Excel連携よりもさらにシンプルで安全な認証方式が実現できることが実証された。これにより「Edgeで実現できないと効果が半減以下」という当初の最大の懸念は完全に払拭された。

### 2.4 フォーム型ログイン（未採用の代替案）

`/imart/login`への通常のフォーム型ログインも調査したが、CSRFトークン（`im_login_info`, `im_page_key`, `im_secure_token`）の事前取得・送信が必要であり、gwlogin方式に比べて実装が複雑になる。**gwlogin方式の採用が確定したため、フォーム型ログインは今後使用しない**（将来gwlogin方式が使えなくなった場合の未使用フォールバック候補として本節に記録のみ残す）。

### 2.5 方式比較表

| | 案α（Content Script注入） | **採用（拡張機能fetchによる直接HTTP通信 + SSO自動ログイン）** |
|---|---|---|
| 認証方式 | 開いているタブのログイン状態に依存 | **Windows統合認証（SSO）を利用。ID/パスワードの保存・入力が一切不要** |
| Edge（IEモード）対応 | 動作保証なし（懸念の中心） | **タブのDOMに一切依存しないため無関係。Chrome・Edge両方で実機検証済み** |
| 管理部門への依頼 | 不要 | **不要**（既存のWindowsドメインログインをそのまま利用するのみ） |
| 新規コンポーネント | Content Script + popup | ブラウザ拡張機能一式（新規開発）+ サーバー側新規API（Teams Excel連携と同パターン） |
| 通信の暗号化 | - | **社内LAN限定のため平文HTTP通信で問題ないことをユーザー確認済み**（12節） |

---

## 3. 全体アーキテクチャ

```
┌───────────────────────────────────────────┐
│ Edge/Chrome ブラウザ（社内PC）                    │
│                                             │
│  ┌───────────────────────────────────┐    │
│  │ ブラウザ拡張機能（新規）                     │    │
│  │  ① fetch(http://suzumo.local/gwlogin)    │    │
│  │     → Windows統合認証(SSO)で自動ログイン     │    │
│  │     → intra-mart用Cookie発行              │    │
│  │  ② fetch(find_group_week) を               │    │
│  │     1〜4週分繰り返し呼び出し（displayDateを   │    │
│  │     ±7日ずつ変えて指定）                     │    │
│  │  ③ レスポンスJSONを解析し、予定オブジェクトを    │    │
│  │     ユニーク化・除外判定・連続日結合            │    │
│  │  ④ popup内で送信先プロジェクト選択              │    │
│  │     ＋予定のチェックボックス選択（デフォルト     │    │
│  │     全て非選択）                             │    │
│  └──────────────┬───────────────────┘    │
│                 │ ⑤ fetch(HTTP/HTTPS POST)      │
│                 │   拡張機能専用トークンで認証        │
└─────────────────┼──────────────────────────┘
                  ▼
┌───────────────────────────────────────────┐
│ WebGanttサーバー（PHP・新規API）                    │
│  api/groupware_schedule_import.php           │
│  ⑥ トークン検証                                │
│  ⑦ projects.snapshot を直接読込・更新            │
│  ⑧ gantt-ws へ full_sync 通知                  │
└───────────────────────────────────────────┘
                  │
                  ▼
┌───────────────────────────────────────────┐
│ gantt-ws（Node.js WebSocketサーバー）              │
│  接続中クライアントへ full_sync 配信                 │
└───────────────────────────────────────────┘
```

- ①〜④は拡張機能内で完結する。①（intra-martへのアクセス）は社内LAN限定であり、WebGanttサーバー（本番・サンドボックスいずれも社内LAN外）からは到達不可能。これが「ブラウザ拡張機能が必須」である技術的根拠である
- ⑤〜⑦はTeams Excel連携の「方式Q（サーバー直接送信方式）」と全く同じ経路を再利用する（10節）
- ⑧はTeams Excel連携で2026-08-19に追加された`_pushGanttFullSyncToWs()`パターンをそのまま踏襲し、初版から実装する（Teams Excel連携では後追い対応だったが、本機能では既知の対策として最初から組み込む）

---

## 4. 確定事項（本セッションでのユーザー回答まとめ）

前セッション〜本セッションでご相談した論点について、ユーザーより以下の回答をいただき、確定した。

### 4.1 通信の暗号化について

> 「社内LAN限定という前提でHTTP（平文）通信は問題ない」

**確定内容**: intra-martとの通信（gwlogin、find_group_week等）はすべて`http://`（平文）であり、社内LAN限定のシステムであるためこのままでよい。WebGanttサーバーへの送信（⑤の経路）は既存の`https://ogma.mydns.jp/`をそのまま使うため暗号化されている。

### 4.2 テスト用拡張機能の配置について

> 「テスト用拡張機能を`browser-extension/`配下に一時的に置くことは問題ない」

**確定内容**: 検証用PoC拡張機能`webgantt-groupware-sso-poc/`をリポジトリにコミットして残してよい（正式実装完了後に削除する運用とする。15節）。

### 4.3 取得範囲（週数）について

> 「他のツールが1週間〜4週間分程度取得する機能があるため同じようにしたい」

**確定内容**: Teams Excel連携と同様、**1〜4週間**を拡張機能ポップアップのUIで選択できるようにする（`displayDate`パラメータを基準週から±7日ずつ変えて`find_group_week`を複数回呼び出す。7節）。

### 4.4 除外ルール・連続日タスク判定ロジックについて（3問すべて確定）

**質問①（フレックス除外）**:
> 「この認識で合っています」

**確定内容**: タイトルに「フレックス」という文字列を含む終日予定（`type:"EVENT"`, `allDay:true`）は、**インポート候補一覧に一切表示せず、一律除外**する。

**質問②（出張等の連続日結合）**:
> 「まとめて1本の連続タスクにするというロジックでよいです」

**確定内容**: 同じ担当者・同じタイトルの終日予定（`type:"EVENT"`）が複数日連続して存在する場合、**まとめて1本の連続タスク（開始日〜終了日）にする**。これは以下の2パターンの両方に対応する（8.3節）:
- パターン1: 最初から1レコードでstart/endが複数日にまたがるもの（例:「夏季休暇」）
- パターン2: 同一タイトルの終日予定が別々の日付レコードとして複数日連続して存在するもの（例:「出張」が3日間、日毎に別レコード）

**質問③（会議SCHEDULEの扱い）**:
> 「(ii)を希望」

**確定内容**: `type:"SCHEDULE"`（会議・打ち合わせ）も**チェックボックス一覧には表示する**が、**デフォルトは全て非選択**とする。これはTeams Excel連携の「予定選択チェックボックスUI」における「初期状態は全て非選択で始まる」方式と挙動を合わせたものである。

### 4.5 保留事項（未確定）

「フレックス」以外に除外すべき勤怠パターン名（例:「時差出勤」等）が存在するかどうかは、明示的な追加確認をまだ行っていない。ユーザーの回答は「①（フレックスのみを想定した認識）で合っている」という同意であり、他パターンの有無への言及はない。**運用開始後、フレックス以外の除外漏れが見つかった場合は、除外キーワードリストに追加できる設計（8.2節）としておき、随時対応する**。

---

## 5. ログイン方式の技術仕様（Windows統合認証によるSSO自動ログイン）

### 5.1 全体フロー（3段階）

拡張機能は、以下の3段階のHTTPリクエストを`fetch(url, {credentials:'include', redirect:'follow'})`で実行するだけで、intra-martへのログインが完結する。

| # | リクエスト | レスポンス | 備考 |
|---|---|---|---|
| ① | `GET http://suzumo.local/gwlogin` | `301` → `Location: http://suzumo.local/gwlogin/`（レスポンスヘッダー`persistent-auth: true`, `server: Microsoft-IIS/10.0`, `x-powered-by: ASP.NET`） | ASP.NET/IIS基盤。ID/パスワードは一切送信しない |
| ② | `GET http://suzumo.local/gwlogin/` | `302` → `Location: http://imap01.suzumo.local/imart/certification?im_user=1109&im_password=v4UgNSaBzr` | Cookieは`ASP.NET_SessionId=...`のみ送信。**ID/パスワードはリクエストに一切含まれない**。Windows統合認証（NTLM）によりサーバー側がユーザーを自動判定し、リダイレクト先URLのクエリパラメータに埋め込んで返す |
| ③ | `GET http://imap01.suzumo.local/imart/certification?im_user=1109&im_password=***` | `200 OK`、`Set-Cookie: jp.co.intra_mart.session.cookie=...; path=/imart; HttpOnly` + `Set-Cookie: JSESSIONID=...; path=/` | intra-mart側のログイン処理エンドポイント。以降のfind_group_week呼び出しはこのCookieで認証される |

- `fetch()`の`redirect: 'follow'`（デフォルト）により、①→②→③は**1回のfetch呼び出しで自動的に完結**する。拡張機能側で個別にリダイレクトを解釈する処理は不要（PoCでの実機検証済み）
- ①②③のいずれにもID・パスワードを拡張機能側で生成・保存・送信する処理は存在しない。**Windows統合認証（NTLM）による自動判定結果がリダイレクトURLに反映される**という、社内ドメイン参加PC特有の仕組みをそのまま利用している

### 5.2 拡張機能での実装方法

```javascript
// popup.js（概念コード）
async function ensureSsoLogin() {
  const resp = await fetch('http://suzumo.local/gwlogin', {
    credentials: 'include',
    redirect: 'follow',
  });
  // resp.ok であれば、この時点で jp.co.intra_mart.session.cookie が
  // imap01.suzumo.local ドメインに発行されている（chrome.cookies.getAllで確認可能）
  return resp.ok;
}
```

- `manifest.json`の`host_permissions`に`http://suzumo.local/*`と`http://imap01.suzumo.local/*`の両方が必要（gwlogin用とintra-mart用のドメインが異なるため）
- `permissions: ["cookies"]`は必須ではないが、デバッグ・状態確認のために保持する（PoCでの実装方針を踏襲）

### 5.3 実機検証結果

Chrome・Edge**両方**で、上記①②③のフルフローおよびその後のスケジュールAPI取得（6節）までが成功することを、検証用PoC拡張機能（`webgantt-groupware-sso-poc/`）で確認済み（16節）。

---

## 6. `find_group_week` API仕様

### 6.1 エンドポイント

```
POST http://imap01.suzumo.local/imart/collaboration/schedule/user/calendar/find_group_week
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
X-jp-co-intra-mart-ajax-request-from-imui-form-util: true
Cookie: jp.co.intra_mart.session.cookie=...; JSESSIONID=...
```

### 6.2 リクエストボディ（Payload）

```
view=groupWeek&displayDate=YYYYMMDD&target=&page=1
```

| パラメータ | 説明 |
|---|---|
| `view` | 固定値 `groupWeek` |
| `displayDate` | 対象週の**日曜日**の日付（`YYYYMMDD`形式）。**未指定（空欄）の場合は今週が対象**。前後の週を取得する場合は±7日ずつ変更して複数回呼び出す（例: 来週分は`displayDate=20260823`） |
| `target` | 空欄でよい（デフォルトのグループ表示設定が使われる） |
| `page` | 固定値 `1` |

- **1〜4週分の取得**（4.3節）は、`displayDate`を基準週の日曜日から±7日ずつ変えて、本APIを最大4回呼び出すことで実現する

### 6.3 レスポンス構造

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

**重要**: `schedules`は「**ユーザー単位の配列の配列**」である。複数人が参加する予定（会議）は、参加者全員の配列に**重複して出現**するため、`scheduleKey.code`によるユニーク化が必須である（8.1節）。

### 6.4 予定オブジェクトの主要フィールド

| フィールド | 説明 |
|---|---|
| `title` | 予定タイトル |
| `start` / `end` | ISO8601形式の開始・終了日時 |
| `eventDate` | 終日予定の対象日 |
| `allDay` | 終日予定かどうか（`true`/`false`） |
| `scheduleKey.code` | 予定の一意キー（重複排除に使用） |
| `type` | `"EVENT"`（個人の終日予定）または`"SCHEDULE"`（会議・打ち合わせ） |
| `targetInfo.name` / `targetInfo.code` | この配列がどのユーザーの予定であるかを示す氏名・コード（=タスクの担当者として直接利用） |
| `registerUserCd` / `registerUserName` | 予定の登録者 |
| `reserveFacility` | 予約された会議室名等（`SCHEDULE`の場合に入ることがある） |
| `startDateString` / `endDateString` | `["yyyy/mm/dd", "H:mm"]`形式の配列 |
| `participants` / `joinUser` / `joinUserCounts` | 参加者情報 |
| `place` / `description` | 場所・詳細メモ |

### 6.5 予定typeの分類（実データで確認済み）

| type | 意味 | allDay | 例 |
|---|---|---|---|
| `EVENT` | 個人の終日予定（勤怠系） | `true` | フレックス、有給、夏季休暇、全日休暇 |
| `SCHEDULE` | 会議・打ち合わせ | `false`（時刻指定あり） | のり巻きロボット定例会、SVR-SSHサービス性評価、C図面打合せ 等 |

---

## 7. 週選択UI仕様（1〜4週間）

- 拡張機能ポップアップに、「取得する週数」を選択するUI（例: ラジオボタンまたはチェックボックスで1〜4週）を設ける（Teams Excel連携の週選択UIと同様の考え方）
- 基準週（今週）の日曜日の日付を起点に、選択された週数分だけ`displayDate`を+7日ずつ増やして`find_group_week`を繰り出す（過去週ではなく**今週以降**の予定を取得する想定。過去週を含めるかは実装時に確認）
- 複数週分のレスポンスから得られた`schedules`はすべて統合してから8節のユニーク化・除外・結合ロジックを適用する（Teams Excel連携の「週またぎ結合」と同様に、週の境界をまたいで連続日判定を行う必要がある）

---

## 8. 予定 → タスク変換ルール

### 8.1 ユニーク化

`schedules`はユーザー単位配列の配列であり、複数人参加の予定は複数の配列に重複出現する。`scheduleKey.code`をキーとして重複を除去した上で、各予定オブジェクトが元々どの配列（＝どのユーザー）に属していたかを記録し、**担当者情報として保持する**（8.4節）。

### 8.2 除外ルール

以下の条件に一致する予定は、インポート候補一覧に**一切表示しない**（一律除外）:

- `type === "EVENT"` かつ `allDay === true` かつ、タイトルに **「フレックス」** という文字列を含む

除外キーワードは今後拡張できるよう、拡張機能内で配列として定義する（例: `const EXCLUDED_ALLDAY_KEYWORDS = ["フレックス"];`）。将来「時差出勤」等の追加が必要になった場合、この配列に追記するだけで対応できる（4.5節の保留事項への対応）。

### 8.3 連続日タスクの結合ロジック（`type === "EVENT"`のみ対象）

同じ担当者（`targetInfo.code`）・同じタイトルの終日予定（`EVENT`、フレックス除外後）が複数日連続して存在する場合、**まとめて1本の連続タスク**にする。以下の2パターン両方に対応する:

```javascript
// 疑似コード（拡張機能popup.js内、除外処理の後、チェックボックス表示直前に実行）
function mergeConsecutiveAllDayEvents(events) {
  // 1. パターン1: 単一レコードで start〜end が複数日にまたがるものは、
  //    そのまま1つの連続タスクとして扱う（結合処理不要）。
  // 2. パターン2: assignee(targetInfo.code) + title の組み合わせでグループ化し、
  //    日付昇順にソート後、日付が「前の予定の翌日」と連続していれば1つの
  //    タスクにマージする（開始日=最初の出現日、終了日=最後の出現日）。
  // 3. 日付が飛んでいる場合はそこで区切り、別々のタスクとして扱う。
  //    (Teams Excel連携の9.3節と異なり、土日を挟んだ「営業日ベース」の
  //     連続判定は本フェーズでは採用しない。intra-martの終日予定は暦日で
  //     連続記録されるため、暦日ベースの連続判定で十分と判断。実装時に
  //     実データで要件どおりか再確認する)
}
```

- `type === "SCHEDULE"`（会議）には結合ロジックを適用しない（会議は個別の予定として1件ずつ扱う）

### 8.4 担当者（assignee）の自動割当

各予定オブジェクトの`targetInfo.name`を、そのままタスクの担当者名として利用する（Excelの苗字部分一致マッチングのような曖昧一致処理は不要。intra-mart側の氏名がそのままプロジェクトメンバー名と一致する前提だが、サーバー側でもTeams Excel連携と同様の二重チェック（正式なメンバー表示名への正規化）を行う。10.2節）。

### 8.5 会議（SCHEDULE）のチェックボックス表示

`type === "SCHEDULE"`の予定も、除外ルール（8.2節はEVENTのみが対象のため、SCHEDULEは無条件で）通過後にチェックボックス一覧に表示するが、**初期状態は非選択**とする（4.4節質問③の確定回答）。ユーザーが個別にチェックを入れた会議のみがインポート対象になる。

### 8.6 フィールドマッピング一覧

| intra-mart予定フィールド | WebGanttタスク |
|---|---|
| `title` | `taskName` |
| `startDateString[0]`（または結合後の最初の出現日） | `startDate`（`YYYY-MM-DD`） |
| `endDateString[0]`（または結合後の最後の出現日） | `endDate`（`YYYY-MM-DD`） |
| `targetInfo.name` | `assignee` |
| `type` | 拡張機能内部でのフィルタ・表示分類にのみ使用（サーバー送信データには含めない） |

---

## 9. チェックボックス選択UI仕様

Teams Excel連携の「予定選択チェックボックスUI」（`gantt-collab.html`の`renderScreenC()`の挙動パターンを参考にした独自実装、Teams Excel連携設計書7.3節参照）と同様の考え方で、拡張機能popup.js内に以下のUIを実装する:

- 取得した予定一覧を、`type`（EVENT/SCHEDULE）・日付・タイトル・担当者を表示したチェックボックス付きリストとして表示する
- **初期状態は全て非選択**（4.4節質問③の確定回答をEVENT/SCHEDULE問わず統一適用する。Teams Excel連携と挙動を合わせる）
- 全選択/全解除ボタンを用意する
- ユーザーがチェックを入れた予定のみを対象に「送信先プロジェクト」を選択し「インポート実行」ボタンを押す

---

## 10. サーバー側API設計

### 10.1 新規APIファイル: `api/groupware_schedule_import.php`

Teams Excel連携（`api/teams_excel_import.php`）と全く同じパターンで、**新規の単独ファイルとして実装する**（11節のコード分離方針）。

エンドポイント（案）:

```
GET  /api/groupware_schedule_import.php?action=token_status   → 発行済みトークンの有無・発行日時を取得（account.html用）
POST /api/groupware_schedule_import.php?action=issue_token     → 新規トークン発行（旧トークンは自動失効）
POST /api/groupware_schedule_import.php?action=revoke_token    → トークン無効化

GET  /api/groupware_schedule_import.php?action=token_verify    → トークンの有効性確認（拡張機能の起動時チェック用）
GET  /api/groupware_schedule_import.php?action=list_projects   → アクセス可能なプロジェクト一覧＋メンバー一覧を取得
POST /api/groupware_schedule_import.php?action=import_tasks    → 選択済みタスク配列を受け取り、対象プロジェクトのsnapshotに追加
```

- `issue_token`/`revoke_token`/`token_status`系（account.htmlから呼ばれる）は既存の**Cookieセッション認証**（`requireAuth()`）
- `token_verify`/`list_projects`/`import_tasks`系（拡張機能から呼ばれる）は**拡張機能専用Bearerトークン認証**（`Authorization: Bearer gws_<hex>`。トークンprefixは Teams Excel連携の`tex_`と区別するため`gws_`（GroupWare Scheduleの意）とする）

### 10.2 実装方針（Teams Excel連携からの再利用）

以下の関数群を、`api/teams_excel_import.php`と**同一のロジック・シグネチャ**で`api/groupware_schedule_import.php`内に個別実装する（コードの共通化はせず、11節の分離方針に従いファイルごとに自己完結させる）:

- `issueExtensionToken(mysqli $db, int $userId): string` — `gws_`プレフィックス、SHA-256ハッシュ保存、`groupware_schedule_extension_tokens`テーブルへUPSERT
- `getAuthorizationHeaderValue(): string` — Authorizationヘッダー取得のフォールバック処理（環境差分対応、そのまま流用）
- `getUserIdFromExtensionToken(mysqli $db): ?int` — `gws_`プレフィックスチェック、SHA-256照合
- `requireExtensionAuth(mysqli $db): array` — 認証必須エンドポイント用ラッパー
- `_pushGanttFullSyncToWs(string $projectId, array $snapshot, int $version): void` — gantt-wsへの内部HTTP POST通知（`api/teams_excel_import.php`と全く同じ実装をコピーして利用。Teams Excel連携で2026-08-19に対応した「後でリロード時にタスクが消える」事故を、本機能では**初版から**防止する）

`import_tasks`の処理フロー（10.2節相当）も、Teams Excel連携の実装（`SELECT ... FOR UPDATE` → snapshot更新 → `operation_logs`記録 → コミット → gantt-ws通知）を**そのまま踏襲**する。`op_type`は`'groupware_schedule_import'`とする。

### 10.3 assigneeの二重チェック（サーバー側）

拡張機能側（8.4節）で`targetInfo.name`をそのまま`assignee`として送信するが、サーバー側でもTeams Excel連携と同様に、プロジェクトメンバー一覧との部分一致による正規化チェックを行う（拡張機能側の実装ミスや、送信までの間のメンバー変更のズレを防止するため）。

---

## 11. コード分離方針（Teams Excel連携11節と同一方針）

「いずれこの機能が廃れ、使わなくなった場合に分離削除しやすくしておいてほしい」という既存プロジェクト全体の方針（Teams Excel連携4.4節で確定した要望）を、本機能にもそのまま適用する。

### 11.1 サーバー側（PHP）

| 種別 | 命名・配置方針 |
|---|---|
| APIファイル | `api/groupware_schedule_import.php` の**単独ファイルに全アクションを収める**。既存の`api/teams_excel_import.php`・`api/projects.php`・`api/auth.php`等には一切変更を加えない |
| DBテーブル | `groupware_schedule_`プレフィックスで統一する（例: `groupware_schedule_extension_tokens`）。既存の`teams_excel_extension_tokens`と同一の命名規約（`user_id BIGINT`、`UNIQUE KEY uq_user_id`、`ON DELETE CASCADE`）を踏襲 |
| ヘルパー関数 | `api/config.php`等の共通ファイルには追加しない。トークン検証関数も`api/groupware_schedule_import.php`内にプライベートに定義する |
| 削除時の手順（将来用に事前定義） | (1) `api/groupware_schedule_import.php`を削除、(2) `DROP TABLE groupware_schedule_*`、(3) `account.html`内の「グループウェア連携」セクションのHTML/JSブロックを削除、の3ステップで完全撤去できるようにする |

### 11.2 拡張機能側

- `browser-extension/webgantt-groupware-importer/`（正式名称は実装時に確定）として、Teams Excel連携の拡張機能フォルダとは完全に独立させる
- 検証用PoC（`webgantt-groupware-sso-poc/`）は正式実装完了後に削除する（15節）

### 11.3 `account.html`側の追加分

- 新規セクション「グループウェア連携」を、既存の「拡張機能連携」（Teams Excel用）セクションとは明確に分離されたHTMLブロック（例: `<section id="groupwareScheduleExtensionSection">...</section>`）として追加する

---

## 12. セキュリティ・運用上の注意点

- 本機能はintra-martとの通信（gwlogin・find_group_week）を**平文HTTP**で行う。社内LAN限定のシステムであるためユーザー確認済みだが、拡張機能インストールPCが社内LAN外（VPN等）から利用される可能性がある場合は再検討が必要
- 本機能は**IT部門・管理部門の関与なし**で導入する（「管理部門への依頼は不可能」というユーザー制約に基づく）。Windows統合認証を「借用」する形の自動ログインであり、intra-mart側の正規のログイン手順を経ずにアクセスするものではない（通常のブラウザアクセスと同じ認証経路を通る）が、社内システムの利用ポリシーに抵触しないか、ユーザー自身の判断・責任で確認すること
- 拡張機能はChromeウェブストアを経由しない「開発者モード」でのインストールとなるため、ブラウザの更新やプロファイルのリセット等で拡張機能が無効化・削除される可能性がある
- 拡張機能専用トークン（`gws_`プレフィックス）は、Teams Excel連携の`tex_`トークンと同様に長期有効な認証情報のため、取り扱いに注意する。紛失・流出の疑いがある場合は`account.html`から即座に無効化できる運用とする
- サーバー側でDBスナップショットを直接更新するため、Teams Excel連携と同様の排他制御・競合リスクがある（10.2節）。「インポート実行中は該当プロジェクトの画面編集を一時的に控える」という運用上の注意喚起を利用手順に明記する
- 「フレックス」以外の除外対象キーワードが将来判明した場合は、8.2節の除外キーワード配列に追記することで対応する（コード変更・再配布が必要になる点は運用上の制約として認識しておく）

---

## 13. 拡張機能開発の基礎知識

Teams Excel連携と同様の手順で導入・運用する（Teams Excel連携設計書13節を参照。フォルダ配置→`edge://extensions`の開発者モードON→「展開して読み込み」→動作確認、という流れは同一）。

---

## 14. 開発・検証環境における注意事項

- 拡張機能自体はユーザーの社内PC上でのみ動作検証が可能（本サンドボックス環境からはintra-martの認証Cookie・社内LANにアクセスできないため、拡張機能の動作確認は必ずユーザー側の実機で行う）
- サンドボックス側では、find_group_weekのレスポンス構造の解析・ユニーク化/除外/連続日結合ロジックの単体テスト（ユーザー提供の実データサンプルを使ったJS関数の動作確認）は実施可能
- 新規APIファイル（`api/groupware_schedule_import.php`）・新規DBテーブルのDDLはサンドボックス内で作成・コミットするが、**本番サーバーへの反映時にはDBマイグレーション（`mysql`コマンドでのDDL実行）が必要**になる（`teams_excel_extension_tokens`導入時と同じ手順）
- gantt-ws（Node.js WebSocketサーバー）の実体は本サンドボックスに存在しないため、`_pushGanttFullSyncToWs()`の呼び出し先エンドポイント（`/internal/full_sync_push`）が本番のgantt-ws/server.jsに実装済みであることは、既にTeams Excel連携（コミット`77267cf`）で対応済みのため問題なく再利用できる想定

---

## 15. 今後の実装ステップ

1. ~~方式調査・実機検証（IEモード懸念の解消、gwlogin方式によるSSO自動ログインの実証）~~ → **完了**（2節・5節）
2. ~~find_group_weekのレスポンス構造・パラメータの解析~~ → **完了**（6節）
3. ~~除外ルール・連続日結合ロジック・会議の扱いについてユーザー確認~~ → **完了（2026-08-21、質問①②③すべて確定）**（4節）
4. **（現在ここ）本設計書のユーザー確認・承認** → 未着手（本ドラフト提示直後）
5. サーバー側実装 → 未着手
   - 新規DDL作成（`docs/sql/2026-08-21_groupware_schedule_extension_tokens.sql`）
   - 新規API `api/groupware_schedule_import.php`
   - `account.html`への「グループウェア連携」セクション追加
6. 拡張機能一式の実装 → 未着手
   - `browser-extension/webgantt-groupware-importer/`（manifest.json、popup.html/js、options.html/js等）
   - SSO自動ログイン処理（5.2節）
   - 週選択UI（1〜4週間、7節）
   - 除外・連続日結合ロジック（8節）
   - チェックボックス選択UI（デフォルト全非選択、9節）
7. サンドボックス内でのロジック単体テスト（ユーザー提供の実データサンプルを利用） → 未着手
8. ユーザー実機での拡張機能インストール・動作確認 → 未着手
9. 本番サーバーへの反映（DBマイグレーション実行 + `git pull`） → 未着手
10. 検証用PoC拡張機能（`webgantt-groupware-sso-poc/`）の削除 → 正式実装完了後に実施

---

## 16. 参考: 実機検証で確認済みの事実

1. `GET http://suzumo.local/gwlogin` → `301` → `Location: http://suzumo.local/gwlogin/`（`persistent-auth: true`ヘッダー確認）
2. `GET http://suzumo.local/gwlogin/` → `302` → `Location: http://imap01.suzumo.local/imart/certification?im_user=1109&im_password=***`（Cookieに`ASP.NET_SessionId`のみ、ID/パスワードはリクエストに含まれない）
3. `GET .../certification?im_user=1109&im_password=***` → `200 OK` → `Set-Cookie: jp.co.intra_mart.session.cookie=...; path=/imart; HttpOnly` + `Set-Cookie: JSESSIONID=...; path=/`
4. 上記フローが確立した状態で `GET http://imap01.suzumo.local/imart/home` を取得すると、レスポンス本文に`<title>ポータル</title>`が含まれる（ログイン成功の判定根拠）
5. `POST .../find_group_week`（Payload: `view=groupWeek&displayDate=&target=&page=1`）→ 今週分のスケジュールJSONを取得成功
6. `POST .../find_group_week`（Payload: `view=groupWeek&displayDate=20260823&target=&page=1`）→ 来週分のスケジュールJSONを取得成功（週指定パラメータ`displayDate`の妥当性を実証）
7. 検証用PoC拡張機能（`browser-extension/webgantt-groupware-sso-poc/`）で、上記①〜③のステップをChrome・Edge**両方**で成功確認済み

以上により、技術的な実現可能性は証明済み。**本設計書についてご確認いただき次第、実装フェーズ（サーバー側API・拡張機能一式）に進む。**
