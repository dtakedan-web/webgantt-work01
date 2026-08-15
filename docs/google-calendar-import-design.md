# Googleカレンダー予定インポート機能 設計書

- 作成日: 2026-08-14
- ステータス: **確定・ユーザー承認済み（2026-08-14、UI名称・サブメニュー構成の追加要望も反映済み）／2026-08-15: 実装着手前調査によりAPI設計を方針転換（6節・8.2節、タスク生成はフロントエンドJS側で実施）、ユーザー承認済み。クライアントID/シークレット発行済み。実装フェーズ進行中**
- 前提: `WebGantt開発コンテキスト.md` の全ルールに従う
  - `gantt-collab.html`（PC版）のコアUI/UXは変更しない
  - Web専用の新機能は最下バーまたは別ページに実装する
  - `#settingsPopover` には一切触れない
  - ワークフローは 設計 → ユーザー確認 → 実装 の順を厳守する
  - コアロジックの変更は Web版（本サンドボックス）にのみ反映。ローカル版（gantt-v0771.html）への反映はユーザー自身の責任

---

## 1. 目的・概要

Googleカレンダーに登録されている予定の一部を、WebGanttのタスクとしてインポートする機能を追加する。ユーザーは連携したいGoogleアカウントで認可を行い、直近1週間〜1ヵ月の予定一覧から取り込みたい予定を選んで、現在開いているプロジェクトにフラットなタスクとして追加できる。

**対象範囲（本フェーズ）**: Googleカレンダーのみ。Microsoft Officeカレンダー・社内システムカレンダーは対象外（Microsoftは検証環境が整い次第、別途設計）。

---

## 2. 確定済み要件（ユーザー確認済み・全8点＋UI/実装方針6点）

| # | 項目 | 確定内容 |
|---|---|---|
| 1 | 対象範囲 | Googleカレンダーのみ先行実装 |
| 2 | Google Cloud Console登録 | ユーザー様側の作業（手順書は別途依頼があれば作成） |
| 3 | 開発・検証環境 | メインサーバー（192.168.1.3, HTTPS, `https://ogma.mydns.jp/WebGantt/`）を使用。サブサーバー（192.168.1.2, HTTP, 生IP）はGoogle OAuthの技術的制約上使用不可（後述4節） |
| 4 | フィールドマッピング | 予定タイトル→タスク名。終日/時刻指定いずれの予定も、開始日・終了日のみ反映し時刻は無視 |
| 5 | インポート粒度 | 階層構造（親子関係）を持たせず、フラットな単一タスクとして追加 |
| 6 | 重複インポート対策 | **実装しない**。「インポート済み」マーキング等は行わない。理由: 元のGoogleカレンダー側データを一切汚染したくないため、Calendar APIへの書き込みアクセスは行わず読み取り専用（read-only）スコープのみを使用する |
| 7 | インポート先 | 現在開いているプロジェクトの最上位（第0階層）に追加 |
| 8 | 連携単位 | プロジェクト単位ではなく、ログインユーザーごとに個別に自分のGoogleアカウントと連携する |
| 9 | UI起動場所・名称 | **案A: 最下バーに新規ボタン「外部連携」＋大型モーダル**。モーダル内は連携先（Googleカレンダー／Officeカレンダー等）を選ぶサブメニュー形式（画面0）から各連携フローに進む階層構造（4節） |
| 10 | トークン暗号化 | **案1: `openssl_encrypt`で暗号化してDB保存**（5.2節） |
| 11 | 期間選択 | **カスタム日付範囲対応**。デフォルトは「今日から1週間」、UIで最大「1ヵ月」まで延長可能（4.2節） |
| 12 | 連携解除UI | **実装する**（4.2節・6節 `disconnect` action） |
| 13 | 繰り返し予定 | Calendar APIの`singleEvents=true`で個別インスタンスに展開して一覧表示する（8節） |
| 14 | Cloud Console手順書 | 本設計書確定と同時に作成し13節に掲載（開発の最初のブロッカーとなるため先出しで説明） |

---

## 3. Google OAuth 2.0 リダイレクトURIに関する技術的制約（重要・確認済み）

Google公式ドキュメント（`https://developers.google.com/identity/protocols/oauth2/web-server`）に基づき、以下を確認済み：

- 非localhostのリダイレクトURIは**必ずHTTPS**でなければならない（プレーンHTTPは拒否）
- ホスト部分に**生のIPアドレスは使用不可**（localhost IPアドレスのみ例外）
- ホストは公開サフィックスリスト（正式TLD）に属するドメイン名が必要
- `googleusercontent.com`ドメイン禁止、URL短縮サービス禁止、userinfoサブコンポーネント禁止、パストラバーサル禁止、オープンリダイレクト禁止、フラグメント禁止、ワイルドカード禁止

**結論**: `http://192.168.1.2:8080/...`（サブサーバー）はプレーンHTTP・生IPアドレスの両方の理由でGoogle Cloud Console側にリダイレクトURIとして登録すること自体が不可能。そのため本機能の開発・検証は必ずメインサーバー（HTTPS + 正式ドメイン）で行う。

---

## 4. UI設計（確定: 案A）

### 4.1 起動場所（確定: 案A — 最下バーに新規ボタン「外部連携」＋大型モーダル）

- ボタン名称は**「外部連携」**（確定・ユーザー指定）。将来Microsoft Officeカレンダー等が追加されても名称変更が不要な、カレンダー連携全般をカバーする総称とする
- `collab-client.js` の `#collab-status-bar` に、既存の `feedBtn`（📢アイコン、`insertBefore(feedBtn, presenceEl)`）と同様のパターンで新規ボタン（例: 🔗アイコン＋「外部連携」ラベル、`id="collab-external-integration-btn"`）を追加
- クリックすると、`projects.html` の `.modal-overlay` / `.modal` / `.modal-header` / `.modal-body` と同じ見た目・構造の大型モーダルを開く
- ページ遷移不要で今開いているプロジェクトのコンテキストをそのまま使える。PC版・モバイル版どちらの画面からもワンタップ/ワンクリックで開始できる
- モバイル版（`gantt-mobile.html`）ではハンバーガーメニュー内に項目追加、PC版（`gantt-collab.html`）ではステータスバーに常時表示する（Task Aの「接続者」実装と同様の考え方）
- `gantt-collab.html`のコアUI/UXへの変更は「ボタン1個の追加」のみに限定し、モーダルの中身は新規要素として完全に独立させる（既存要素の改変なし）

### 4.1.1 モーダル内サブメニュー構成（確定・追加要望）

「外部連携」ボタンをクリックして最初に開くモーダルは、**連携先カレンダーの種類を選ぶサブメニュー（画面0）**であり、その先で選んだ種類ごとの連携フロー（画面A〜C、4.2節）に進む、階層的な選択UIとする。

```
[「外部連携」ボタンをクリック/タップ]
       ↓
┌─────────────────────────────────┐
│ 画面0: 連携先の選択                  │
│                                   │
│  📅 Googleカレンダー          >     │  ← クリック可能。選択すると画面Aへ
│  📧 Officeカレンダー（準備中）  >     │  ← グレーアウト表示、クリック不可
│                                   │
└─────────────────────────────────┘
       ↓ (「Googleカレンダー」をクリック)
   （4.2節の画面A/B/Cへ。各画面には
    「← 連携先の選択に戻る」リンクを設置）
```

- 画面0はモーダルを開いた際の初期表示（今後Microsoft対応時はここに「Officeカレンダー」の行を有効化するだけで追加できる拡張性を持たせる）
- 「Officeカレンダー」は本フェーズでは確認環境が無いため未実装。行自体は表示するが、グレーアウト＋「準備中」ラベルでクリック不可とする（クリック時にトースト等で「現在準備中です」と案内する程度に留める。詳細な待機UIは実装コストとのバランスから今回は簡易実装とする）
- 社内システムカレンダーは今回のスコープ外のため、画面0には表示しない
- 画面A/B/C（4.2節）内に「← 連携先の選択に戻る」リンクを追加し、画面0に戻れるようにする（サブメニューを進める・戻るという階層的な操作感を実現）

### 4.2 画面フロー（確定・Googleカレンダーを選択した以降）

画面0（4.1.1節）で「Googleカレンダー」を選択した後の画面フロー。各画面には「← 連携先の選択に戻る」リンクを設置（画面0へ戻る）。

```
[画面0で「Googleカレンダー」をクリック]
       ↓
┌─────────────────────────────────┐
│ 画面A: 未連携時                    │
│  ← 連携先の選択に戻る                │
│  「Googleカレンダーと連携」ボタンのみ表示 │
│  → クリックでOAuth認可画面へリダイレクト  │
└─────────────────────────────────┘
       ↓ (Google側で同意)
┌─────────────────────────────────┐
│ コールバック処理（サーバー側）           │
│ 認可コード→トークン交換→DB保存→モーダル復帰 │
│ （復帰後は画面Bを表示。画面0は経由しない）    │
└─────────────────────────────────┘
       ↓
┌───────────────────────────────────┐
│ 画面B: 連携済み時                      │
│  ← 連携先の選択に戻る                    │
│  連携中のGoogleアカウント表示（メール等）      │
│  期間選択（カスタム日付範囲対応）:              │
│    開始日: [2026/08/14] 終了日: [2026/08/21]   │
│    ※デフォルト = 今日から1週間後               │
│    ※終了日は開始日から最大1ヵ月後まで選択可      │
│      （それを超える日付はピッカーで選択不可に）    │
│  「予定を読み込む」ボタン                    │
│  「連携を解除」ボタン（小さく、画面Bのみ表示）     │
└───────────────────────────────────┘
       ↓ (「予定を読み込む」クリック)
┌─────────────────────────────────┐
│ 画面C: 予定一覧表示                 │
│  ← 連携先の選択に戻る                │
│  ☐ 予定タイトル1  8/15(土)          │
│  ☐ 予定タイトル2  8/16(日)〜8/17(月)  │
│  ☐ 予定タイトル3  8/18(火)          │
│  ...(チェックボックスで複数選択)         │
│  [全選択] [全解除] [期間を変更]        │
│  「選択した予定をインポート」ボタン         │
└─────────────────────────────────┘
       ↓ (インポート実行)
┌─────────────────────────────────┐
│ 完了メッセージ「N件のタスクを追加しました」  │
│ → モーダルを閉じてガント画面をリロード/再描画 │
└─────────────────────────────────┘
```

※「Officeカレンダー」等、今後追加される連携先も、それぞれ画面0から選択すると同様の画面A〜Cの構成（未連携→連携済み→予定選択）を持つ想定とする。

### 4.3 期間選択UIの詳細（確定）

- 開始日・終了日をそれぞれ日付ピッカー（既存の`#calendarPopover`と同種のUIコンポーネントを流用予定）で選択できるカスタム範囲入力とする
- **デフォルト値**: 開始日=モーダルを開いた当日、終了日=当日から1週間後
- **上限**: 終了日は開始日から最大1ヵ月後まで（それを超える日付は選択不可、または選択時にエラーメッセージで最大範囲にクランプする）
- 「予定を読み込む」ボタン押下時に、選択中の開始日・終了日を`list_events`APIへ送信する（6節参照）
- 画面Cの予定一覧表示中に「期間を変更」ボタンで画面Bに戻り、範囲を再選択できる

### 4.4 連携解除UIの詳細（確定）

- 画面Bに「連携を解除」ボタンを配置（誤操作防止のため確認ダイアログ（`confirm()`または簡易モーダル）を表示してから実行）
- 実行すると`disconnect` action（6節）を呼び出し、`google_calendar_tokens`の該当行を削除。UIは画面Aに戻る

---

## 5. DB設計

### 5.1 新規テーブル: `google_calendar_tokens`

ユーザー単位でGoogle連携情報を1件保持する。

```sql
CREATE TABLE google_calendar_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  google_email VARCHAR(255) NULL,           -- 連携先Googleアカウントのメールアドレス（表示用）
  access_token TEXT NOT NULL,               -- 暗号化して保存（6.2節参照）
  refresh_token TEXT NOT NULL,              -- 暗号化して保存
  token_expires_at DATETIME NOT NULL,       -- access_tokenの有効期限
  scope VARCHAR(255) NOT NULL DEFAULT 'https://www.googleapis.com/auth/calendar.readonly',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_id (user_id),
  CONSTRAINT fk_gct_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

備考:
- `users`テーブルの主キー名・型は既存スキーマに合わせて調整が必要（`api/config.php`等の既存コードから実際の型を確認する）
- 1ユーザー1連携（`UNIQUE KEY uq_user_id`）とし、再連携時は既存行をUPDATEする方針
- **`tasks`テーブルへの本機能用スキーマ変更は不要**（重複防止の仕組みを持たないため、インポート元IDを記録するカラム等は追加しない。かつ6.2節の方針転換により、タスクデータ自体もPHP側からDBへ直接書き込むことはない）
- なお`google_calendar_tokens`テーブル自体もマイグレーションSQLファイルとして`docs/`配下に保存し、本番サーバーの`mysql`コマンドで手動実行する運用とする（本プロジェクトには既存の`sql/schema.sql`相当の一元管理ファイルが存在しないため）

### 5.2 トークンの暗号化（確定: 案1）

`access_token` / `refresh_token` はPHPの `openssl_encrypt` / `openssl_decrypt`（AES-256-CBC等）で対称鍵暗号化してDBに保存する。
- 暗号化鍵は `.env` の新規環境変数 `WEBGANTT_TOKEN_ENCRYPTION_KEY` で管理し、`.env.example` にはプレースホルダのみ記載（実鍵は絶対にコミットしない）
- 保存時: `openssl_encrypt($token, 'aes-256-cbc', $key, 0, $iv)` の形式で、IV（初期化ベクトル）はトークンごとにランダム生成し、暗号文と一緒に保存（例: `base64(iv) . ':' . base64(ciphertext)` の形式でTEXT列に格納）
- 復号時: `list_events` / `import` 呼び出し時にサーバー側でのみ復号し、フロントエンドには生トークンを一切渡さない（既存の`config.php`パターンと同様、トークンを扱うロジックは全てサーバー側APIに閉じる）

---

## 6. API設計（方針転換・確定: 2026-08-15）

**重要な方針転換**: 実装着手前のコード調査により、`gantt-collab.html`のタスクデータは**PHP側のREST API経由でDBに書き込まれる経路が存在しない**ことが判明した（既存の「新規タスク追加」はフロントエンドJS内で`state.rows`/`state.tasks`に直接pushし、`gantt:op`（COLLAB-HOOK）→ `collab-client.js`（Socket.IO）→ Node.js WebSocketサーバー（`gantt-ws`、本サンドボックス外）経由でのみ永続化・同期される設計）。

このため、**PHP側API（`api/calendar_import.php`）の役割を「Google認可・トークン管理・予定データの取得」までに限定**し、実際のタスク生成・追加処理は**フロントエンドJS側（`gantt-collab.html`）** で行う方針に変更する（ユーザー承認済み・2026-08-15）。

新規ファイル `api/calendar_import.php` を追加し、既存の `api/auth.php` と同じ `?action=xxx` ルーティングパターンを踏襲する。

| メソッド | action | 説明 |
|---|---|---|
| GET | `status` | 現在ログイン中ユーザーのGoogle連携状態を返す（未連携/連携済み＋メールアドレス） |
| GET | `authorize` | Google OAuth認可URLを生成しリダイレクト（`state`パラメータにCSRF対策トークン＋セッションIDを埋め込む） |
| GET | `callback` | Googleからの認可コードを受け取り、アクセストークン/リフレッシュトークンと交換し`google_calendar_tokens`に保存。完了後、元のガント画面（モーダルが開いた状態）にリダイレクト |
| POST | `disconnect` | 連携解除。該当ユーザーの`google_calendar_tokens`行を削除（Google側のトークン失効APIも呼び出す） |
| GET | `list_events` | クエリパラメータ`start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`でカスタム期間を指定し、Google Calendar API（`events.list`, read-only, `singleEvents=true`で繰り返し予定を個別インスタンスに展開）で予定一覧を取得して**JSON形式でフロントエンドに返す**（DB書き込みは行わない）。サーバー側で`end_date - start_date <= 31日`を検証し、超過時は400エラー。トークン期限切れ時は`refresh_token`で自動更新 |

**（削除）** `POST import` アクションは実装しない。PHP側からの`tasks`テーブル直接書き込みは行わない。

### 6.1 既存パターンとの整合

- `config.php`の`getDb()` / `sendJson()` / `sendError()` / `handlePreflight()` / `getSessionIdFromCookie()`をそのまま利用
- 外部API呼び出しは `MailSender.php` のcurl_init()パターンを参考にする（Google API PHPクライアントライブラリ`google/apiclient`の利用を推奨。`api/composer.json`に追加が必要）
- **実装済み補足（2026-08-15）**: 連携先Googleアカウントのメールアドレス（表示用、`google_email`カラム）は、当初想定していた`userinfo.get()` API呼び出しではなく、認可コード交換時に取得する`id_token`を`Google\Client::verifyIdToken()`で検証・デコードして抽出する方式で実装した。これに伴いスコープに`openid`・`https://www.googleapis.com/auth/userinfo.email`を追加（いずれも識別用の読み取りスコープであり、read-only厳守の設計方針に影響しない）。CSRF対策の`state`検証はPHPネイティブセッション（`session_start()`）に保存する方式とし、既存の`gantt_session`Cookie／`sessions`テーブルによる認証方式には一切変更を加えていない

### 6.2 タスク生成・追加処理（フロントエンドJS側・新方針）

`list_events`で取得した予定データ（JSON配列）は、画面C（予定一覧）でユーザーが選択後、「選択した予定をインポート」ボタン押下時に**サーバーを介さずフロントエンドJSのみで処理**する:

1. `gantt-collab.html`に新規関数（例: `importGoogleCalendarEvents(events)`）を追加する
2. 既存の`executeImport()`（JSONインポート機能、21095行目付近）と同様のパターンを踏襲: 各予定について`generateId('row')` / `generateId('task')`で新規row/taskオブジェクトを生成し、`state.rows` / `state.tasks`に**一括push**（第0階層・フラット、既存確定要件5・7を満たす）
3. `render()`を呼び出し画面を再描画
4. **COLLAB-HOOKは個別`task_add`ではなく`state_sync`（`subtype: 'calendar_import'`）で1回だけ発火**する（`executeImport()`の末尾パターンと同一。複数タスクを1度にまとめて同期するため）:
   ```javascript
   document.dispatchEvent(new CustomEvent('gantt:op', { detail: {
     op: 'state_sync', subtype: 'calendar_import',
     snapshot: JSON.parse(buildSerializableProject())
   }}));
   ```
5. この新規関数は「外部連携」モーダル（新規UI）からのみ呼び出される想定で、既存のUI要素（ツールバー・ポップオーバー・ダイアログ）は一切変更しない。追加は「新規関数1つ」のみに限定する
6. モーダル側（新規UI、フロントエンドJS）が`GET /api/calendar_import.php?action=list_events`をfetchし、返却されたJSON配列をこの関数に渡す、という結合になる

### 6.2 スコープ（read-only厳守）

```
https://www.googleapis.com/auth/calendar.readonly
```
または、より限定的な
```
https://www.googleapis.com/auth/calendar.events.readonly
```
のいずれかを使用し、**書き込み系スコープは一切要求しない**。これによりGoogle Calendar側へのデータ変更は技術的に不可能になる。

---

## 7. OAuth 2.0 認可フロー設計

### 7.1 Google Cloud Console側の設定（ユーザー様作業）

詳細な手順は12節「Google Cloud Console 登録手順書」を参照。概要:
- OAuth同意画面の設定（アプリ名、スコープにcalendar.readonly追加）
- OAuthクライアントID作成（種類: ウェブアプリケーション）
- 承認済みリダイレクトURI: `https://ogma.mydns.jp/WebGantt/api/calendar_import.php?action=callback`
- 発行されたクライアントID・クライアントシークレットをユーザーから受領し、サーバーの`.env`に設定

### 7.2 サーバー側フロー

```
1. ユーザーが「Googleカレンダーと連携」をクリック
   → GET /api/calendar_import.php?action=authorize
2. サーバーはstateトークンを生成しセッションに保存、
   Googleの認可エンドポイントへリダイレクト
   （client_id, redirect_uri, scope=calendar.readonly,
     access_type=offline（refresh_token取得のため）,
     prompt=consent, state）
3. ユーザーがGoogle側で同意
4. Googleがredirect_uriに認可コードを付けてリダイレクト
   → GET /api/calendar_import.php?action=callback&code=...&state=...
5. サーバーはstateを検証後、認可コードをアクセストークン/
   リフレッシュトークンに交換（トークンエンドポイントへPOST）
6. google_calendar_tokensテーブルにupsert
7. 元のガント画面へリダイレクト（連携完了状態でモーダル再表示）
```

### 7.3 新規環境変数（`.env.example`への追加案）

```
WEBGANTT_GOOGLE_CLIENT_ID=
WEBGANTT_GOOGLE_CLIENT_SECRET=
WEBGANTT_GOOGLE_REDIRECT_URI=https://ogma.mydns.jp/WebGantt/api/calendar_import.php?action=callback
WEBGANTT_TOKEN_ENCRYPTION_KEY=
```

`.gitignore`には既存の`.env`除外に加え、万一クライアントシークレットJSONファイルをローカルに置く場合の除外パターン（例: `client_secret*.json`）追加を検討。

---

## 8. データマッピング・登録ロジック

### 8.1 フィールドマッピング（確定済み）

| Googleカレンダー予定 | WebGanttタスク |
|---|---|
| `summary`（予定タイトル） | タスク名 |
| `start.date`（終日）または`start.dateTime`（時刻指定、日付部分のみ抽出） | 開始日 |
| `end.date`（終日）または`end.dateTime`（時刻指定、日付部分のみ抽出） | 終了日 |
| （時刻情報） | 使用しない（無視） |

補足: Google Calendar APIの終日イベントは`end.date`が排他的（終了日の翌日を指す）仕様のため、タスクの終了日に変換する際は**1日減算**する変換処理が必要（実装時の注意点として明記）。

補足2（繰り返し予定）: `events.list`呼び出し時に`singleEvents=true`を指定し、繰り返し予定（recurring event）は個別の発生インスタンスに展開された状態で一覧取得する。一覧表示・インポート処理は通常の単発予定と同一のロジックで扱い、特別な階層化や集約は行わない（確定要件13）。

### 8.2 登録ロジック（方針転換・6.2節参照）

- インポート対象は常に**現在開いているプロジェクトの第0階層（最上位）**に追加
- 親子関係・階層構造は一切持たせない（フラットな単一タスクとして追加）
- **6節の方針転換により、PHP側APIやDBへの直接書き込みは行わない。** `gantt-collab.html`のフロントエンドJS内で`state.rows`/`state.tasks`へ一括pushし、既存のCOLLAB-HOOK経由（`state_sync`イベント）でWebSocketサーバーに送信・永続化される（既存の`executeImport()`と同一の経路）

### 8.3 重複防止（意図的に非実装）

- 同一予定を複数回インポートしても防止する仕組みは設けない
- インポート済みかどうかの印付け・フラグ管理は行わない
- **理由（設計方針として明記）**: 元のGoogleカレンダー側データへの書き込み・タグ付け等の変更を一切行いたくないため。read-onlyアクセスを徹底する設計方針の帰結であり、既知の仕様上の制約として記録する

---

## 9. エラーハンドリング方針

| ケース | 挙動 |
|---|---|
| アクセストークン期限切れ | `refresh_token`で自動更新後、リトライ。更新も失敗した場合は再連携を促すメッセージを表示 |
| リフレッシュトークンも無効（ユーザーがGoogle側でアクセス取り消し等） | 「連携が無効になりました。再度連携してください」と表示し、画面Aへ戻す |
| Calendar API呼び出し失敗（ネットワークエラー等） | 「予定の読み込みに失敗しました。時間をおいて再試行してください」とエラーメッセージ表示 |
| インポート実行時のDB書き込み失敗 | 部分的な成功/失敗を明示（成功件数・失敗件数を表示）、失敗時はロールバック |
| stateパラメータ不一致（CSRF疑い） | コールバック処理を中断しエラー表示 |

---

## 10. 開発・検証環境における手順とリスク最小化策

- 開発・検証はメインサーバー（192.168.1.3、`https://ogma.mydns.jp/WebGantt/`）で実施
- リスク最小化策:
  - 実装中は機能フラグ（例: 起動ボタン自体を`display:none`にする、または`?enable_calendar_import=1`等の隠しクエリで有効化）で通常利用者に見えない状態を維持し、検証完了後に有効化する
  - 専用のコールバックURL（`action=callback`）を新設するのみで、既存の認証・セッション処理には一切手を加えない
  - ロールバック手順: 新規追加ファイル（`api/calendar_import.php`、新規DBテーブル）を削除／`DROP TABLE`すれば旧状態に復元可能。既存ファイルへの変更は最下バーへのボタン追加1箇所のみに限定する方針（案A採用時）

---

## 11. 確認済み事項まとめ

本設計書に記載した全14点の要件・実装方針（2節参照）はユーザー確認・承認済み（2026-08-14）。設計フェーズは完了とし、以降は「Google Cloud Console登録」→「実装フェーズ」に進む。

---

## 12. Google Cloud Console 登録手順書（ユーザー様作業）

実装（特にサーバー側のOAuthコールバック実装）に着手する前に、Google Cloud Console側でのアプリ登録が必要です。以下の手順をユーザー様にて実施いただき、発行された **クライアントID** と **クライアントシークレット** を私にお伝えください（受け渡し方法は、チャット直接貼り付けではなく、可能であれば`.env`ファイルへの直接設定、または安全な方法でのご共有を推奨します）。

### 12.1 事前準備

- Googleアカウント（連携させたいGoogleカレンダーのアカウントである必要はなく、開発用の管理アカウントで問題ありません）
- メインサーバーのドメイン確定済みであること: `https://ogma.mydns.jp/WebGantt/`（3節で確認済み）

### 12.2 手順

1. **Google Cloud Consoleにアクセス**
   `https://console.cloud.google.com/` にアクセスし、Googleアカウントでログイン

2. **新規プロジェクトを作成**（既存プロジェクトがあれば流用可）
   画面上部のプロジェクト選択メニュー →「新しいプロジェクト」→ 名前を入力（例: `WebGantt-Calendar-Import`）→「作成」

3. **Google Calendar APIを有効化**
   左メニュー「APIとサービス」→「ライブラリ」→ 検索ボックスで「Google Calendar API」を検索 → 「有効にする」をクリック

4. **OAuth同意画面を設定**
   左メニュー「APIとサービス」→「OAuth 同意画面」
   - User Type: 「外部」を選択（社内限定であれば組織のGoogle Workspaceがある場合は「内部」も選択可）
   - アプリ名: 例「WebGantt カレンダー連携」
   - サポートメール: 管理者のメールアドレス
   - スコープの追加: 「スコープを追加または削除」から以下のいずれかを追加
     - `.../auth/calendar.readonly`（推奨。カレンダー全体の読み取り専用アクセス）
   - テストユーザー（アプリが「テスト」ステータスのままの場合、実際に連携する全てのGoogleアカウントをここに追加する必要があります。本番公開審査を受けない場合は、利用予定の全ユーザーのGoogleアカウントをテストユーザーとして登録してください）

5. **OAuthクライアントIDを作成**
   左メニュー「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」
   - アプリケーションの種類: **「ウェブ アプリケーション」**を選択
   - 名前: 例「WebGantt Web Server」
   - **承認済みのリダイレクト URI** に、以下を**そのまま正確に**入力（実装フェーズで確定するコールバックURLと完全一致させる必要があります）:
     ```
     https://ogma.mydns.jp/WebGantt/api/calendar_import.php?action=callback
     ```
   - 「作成」をクリック

6. **クライアントID・クライアントシークレットの受領**
   作成完了後に表示される「クライアントID」と「クライアント シークレット」をコピーし、安全な方法で共有してください。これらは`.env`ファイルの以下の変数に設定します（7.3節参照）:
   ```
   WEBGANTT_GOOGLE_CLIENT_ID=（ここに設定）
   WEBGANTT_GOOGLE_CLIENT_SECRET=（ここに設定）
   ```

### 12.3 注意事項

- テストユーザーに登録されていないGoogleアカウントで連携を試みると、Google側の認可画面で「このアプリはGoogleで確認されていません」等の警告、またはアクセス拒否が発生します。開発・検証で使用する全てのGoogleアカウントを事前にテストユーザーへ追加してください
- クライアントシークレットは`.gitignore`で除外された`.env`ファイルにのみ保存し、絶対にGitリポジトリにコミットしないでください
- リダイレクトURIの完全一致（末尾のスラッシュ有無、httpとhttpsの違い等）が非常に厳密にチェックされるため、実装時に確定するコールバックURLと1文字も違わないように設定してください

---

## 13. 今後の実装ステップ（2026-08-15更新）

1. ~~Google Cloud Console登録~~ → **完了**（ユーザー様がクライアントID/シークレット発行済み）
2. `.env.example` / `.gitignore`更新（7.3節）— 環境変数テンプレート追加
3. DBマイグレーションSQL作成（`google_calendar_tokens`テーブル、5節）— `docs/`配下にSQLファイルとして保存、本番サーバーで手動実行
4. `api/composer.json`へ`google/apiclient`追加
5. `api/calendar_import.php`実装（status/authorize/callback/disconnect/list_events の5アクション、6節・方針転換反映）
6. フロントエンドUI実装:
   - `collab/collab-client.js`: 「外部連携」ボタン追加（4.1節）
   - `gantt-collab.html`: モーダルHTML/CSS（画面0→画面A/B/C、4.1.1・4.2節）＋新規関数`importGoogleCalendarEvents()`（6.2節）を追加
7. Playwrightテスト（OAuth部分はモック化、UI操作フロー・期間選択・複数選択・インポート実行を中心に検証）＋実機でのGoogle実アカウントによる疎通確認
8. ドキュメント更新・コミット・push
