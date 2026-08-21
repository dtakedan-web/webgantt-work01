# Outlookカレンダー（ICS連携）予定インポート機能 設計書

- 作成日: 2026-08-17
- ステータス: **実装完了・本番デプロイ完了・実機動作確認済み（2026-08-17）。ユーザー最終確認済み「問題なく、ICS登録と実際のOutlookカレンダーからのガントチャートへのデータ読み取り〜反映までができました」**
- 前提: `WebGantt開発コンテキスト.md` の全ルールに従う
  - `gantt-collab.html`（PC版）のコアUI/UXは変更しない
  - Web専用の新機能は最下バーまたは別ページに実装する
  - `#settingsPopover` には一切触れない
  - ワークフローは 設計 → ユーザー確認 → 実装 の順を厳守する
  - コアロジックの変更は Web版（本サンドボックス）にのみ反映。ローカル版（gantt-v0771.html）への反映はユーザー自身の責任
- 姉妹設計書: `docs/google-calendar-import-design.md`（Googleカレンダー連携。画面0/B/Cの構成・UIパターン・COLLAB-HOOK方式は本機能でも踏襲する）

---

## 1. 目的・概要

Outlook / Microsoft 365の予定表に登録されている予定の一部を、WebGanttのタスクとしてインポートする機能を追加する。Googleカレンダー連携（`docs/google-calendar-import-design.md`）と同一の画面構成（画面0サブメニュー→画面A→画面B→画面C）で提供し、ユーザーは自分のOutlook予定表を「ICS購読リンク」経由で連携し、直近1週間〜1ヵ月の予定一覧から取り込みたい予定を選んで、現在開いているプロジェクトにフラットなタスクとして追加できる。

**メニュー上の名称（確定）**: 「**Outlookカレンダー（ICS連携）**」

**対象範囲（本フェーズ）**: Outlook / Microsoft 365予定表（Exchange Online）の「予定表を公開する」機能で発行されるICS購読URL経由の連携のみ。

---

## 2. 方式転換の経緯（重要・必読）

### 2.1 当初計画（Azure AD OAuth 2.0、断念）

当初はGoogleカレンダー連携と同様、**Azure AD（Microsoft Entra ID）アプリ登録によるOAuth 2.0認可コードフロー**（`Calendars.Read`委任スコープ）を計画していた。

しかし実装準備を進める過程で、以下の問題が判明した：

1. ユーザーの会社アカウントは、組織ポリシーによりAzure Portal管理画面へのアクセスが完全にブロックされている（401エラー）
2. 開発側で御社テナントを一切使わず、開発者個人のMicrosoftアカウント経由で新規マルチテナントAzure ADアプリを登録する代替案を実行し、アプリ登録自体（アプリ名: `WebGantt Calendar Import`、クライアントID: `b0ff437f-8196-4907-a180-cdf001042e52`）には成功した
3. しかし、実機検証（`Calendars.Read`委任権限を追加し、ユーザーの会社アカウントで実際に認可URLを開くテスト）を行った結果、**「管理者の承認が必要」という画面が表示され、一般ユーザー自身の同意では連携できないことを確認した**
   - 原因: Azure AD（Entra ID）の`risk-based step-up consent`機能（既定でON）により、2020年11月以降に登録された「発行元未確認」のマルチテナントアプリは、組織の同意ポリシー次第で一般ユーザーの同意がブロックされる
   - 発行元確認（Publisher Verification）プログラムは「Entra work/schoolアカウントで登録されたアプリのみ」対象であり、開発者個人のMicrosoftアカウントで登録した今回のアプリはそもそも発行元確認を受けられない
   - 御社IT部門への管理者承認の申請は「ほぼ100%通らない」とユーザーより判断され、Azure AD OAuth方式は**断念**

### 2.2 代替方式: ICS購読URL方式（確定・採用）

Exchange Online / Outlookには、Azure ADのアプリ同意とは全く別の仕組みとして「**予定表を公開する（Publish a Calendar）**」という、エンドユーザー本人の設定だけで完結する機能が存在する。

- 実機検証の結果、ユーザーの会社アカウントでこの機能（Outlook on the web → 設定 → 予定表 → 共有予定表 → 予定表を公開する）が組織ポリシーでブロックされておらず、**ICS購読URLの発行に成功した**ことを確認済み
- 発行されたICS購読URLに対し、本サンドボックス環境から実際にHTTP GETリクエストを送信し、以下を確認済み：
  - HTTPステータス: `200 OK`（認証不要でアクセス可能）
  - `Content-Type: text/calendar; charset=utf-8`（標準的なICS/vCalendar形式）
  - 予定（`VEVENT`）182件を含む有効なICSデータが取得できた
- この方式は**Azure ADアプリ登録・OAuth・クライアントシークレット・管理者同意のいずれも一切不要**であり、IT部門への申請なしに実現可能

**結論**: 本機能はICS購読URL方式で実装する。当初計画していたAzure ADアプリ（`WebGantt Calendar Import`）は使用しない（削除するかどうかは今後の判断、実害はないため保留可）。

### 2.3 方式比較表

| | 当初案（Azure AD OAuth） | **採用（ICS購読URL方式）** |
|---|---|---|
| 認証方式 | OAuth 2.0（Microsoft側同意画面） | なし（ユーザーがOutlook設定で発行したURLを貼り付け） |
| IT部門関与 | 必要（実機検証の結果ブロックされた） | **不要** |
| スコープ/権限 | `Calendars.Read`（委任） | 該当なし（公開された読み取り専用ICSを取得するのみ） |
| データ更新頻度 | ほぼリアルタイム | **数十分〜半日程度のタイムラグあり**（Microsoft側の公開キャッシュ仕様） |
| 対応可能なアカウント | 会社アカウントのみ想定 | 会社アカウント・個人Outlook.com/Live.com双方で同一方式が使える |
| 書き込みリスク | スコープをread-onlyに限定する設計が必要 | 仕組み上、書き込み権限が技術的に存在しない（公開データの読み取りのみ） |

---

## 3. UI設計

### 3.1 画面0（サブメニュー）の変更

`docs/google-calendar-import-design.md` 4.1.1節で定義済みの画面0に、グレーアウト表示されている「Officeカレンダー（準備中）」行を**有効化**する。

```
┌─────────────────────────────────┐
│ 画面0: 連携先の選択                  │
│                                   │
│  📅 Googleカレンダー          >     │
│  📧 Outlookカレンダー（ICS連携） >    │  ← 新規に有効化
│                                   │
└─────────────────────────────────┘
```

- 表示ラベルを「Officeカレンダー（準備中）」から「**Outlookカレンダー（ICS連携）**」に変更し、クリック可能にする
- クリック時のイベントハンドラを、現状の「準備中トースト表示」から、Office用の画面A（3.2節）へ遷移する処理に差し替える

### 3.2 画面A（未連携時）— Google版との差分（本機能の核心的な変更点）

Googleカレンダー連携の画面Aは「OAuth認可ボタン1個のみ」だが、本機能ではOAuthを使わないため、**ICS購読URLの入力フォーム**に置き換える。

```
┌─────────────────────────────────────────┐
│ 画面A: 未連携時                            │
│  ← その他の外部連携に戻る                    │
│                                           │
│  Outlookの予定表を連携すると、予定をガント        │
│  チャートのタスクとして取り込めます。            │
│                                           │
│  【連携手順】                              │
│  1. Outlook on the web (outlook.office.com) │
│     にサインイン                            │
│  2. 設定 → 予定表 → 共有予定表 を開く          │
│  3. 「予定表を公開する」でご自身の予定表を選択、    │
│     アクセス許可は「完全な詳細」を選択して公開      │
│  4. 発行された「ICS」リンクをコピーし、           │
│     下記の入力欄に貼り付けてください             │
│                                           │
│  ICS購読リンク:                            │
│  [___________________________________]   │
│                                           │
│  ※このリンクを知っている人は誰でも予定表の内容を   │
│    閲覧できます。第三者に共有しないでください。    │
│                                           │
│  「連携する」ボタン                          │
└─────────────────────────────────────────┘
```

- 入力欄は`type="url"`のテキストボックス（1行）
- 「連携する」ボタン押下時、フロントエンドJS側で簡易フォーマットチェック（`https://` から始まるURLであること）を行った上で、`connect` action（4節）にPOST送信する
- サーバー側では、実際にそのURLへHTTP GETを試行し、`Content-Type`が`text/calendar`系であること・ICSとしてパース可能であることを検証してから保存する（不正なURL・現時点で無効なURLの誤登録を防ぐ）
- 検証に失敗した場合は「連携に失敗しました。URLが正しいか、公開設定が有効か確認してください」という趣旨のエラーメッセージを表示し、画面Aに留まる

### 3.3 画面B（期間選択）— 変更なし

Googleカレンダー連携の画面B（`docs/google-calendar-import-design.md` 4.2節・4.3節）と全く同じ構成・ロジックをそのまま流用する。

- 開始日・終了日のカスタム範囲選択（デフォルト: 今日から1週間、最大1ヵ月まで延長可）
- 「連携中のアカウント」表示部分は、メールアドレスの代わりに**登録時のラベル**（4.1節`display_label`）または「Outlook予定表と連携中」という固定文言を表示する
- 「連携を解除」ボタンは同様に配置（確認ダイアログ→`disconnect` action呼び出し）

### 3.4 画面C（予定一覧・選択・インポート）— 変更なし

Googleカレンダー連携の画面C（`docs/google-calendar-import-design.md` 4.2節）と全く同じ構成・ロジックをそのまま流用する。チェックボックスでの複数選択、全選択/全解除、期間変更、インポート実行（`importGoogleCalendarEvents`と対になる新規関数、6.2節参照）まで完全に同一パターン。

### 3.5 タイムラグに関する注記（新規・Google版にはない要素）

ICS購読は仕組み上、Microsoft側でのキャッシュ更新に依存するため、直近の予定変更が反映されるまで**最大数時間程度のタイムラグ**が生じる場合がある。この点をGoogle版にはない新規の注記として、画面A（3.2節のフォーム下）に一言添える：

> 「※予定の変更がここに反映されるまで、数十分〜半日程度かかる場合があります」

---

## 4. DB設計

### 4.1 新規テーブル: `office_calendar_tokens`

ユーザー単位でOutlook予定表のICS購読URLを1件保持する。テーブル名は当初案（Azure AD OAuth前提）から変更しないが、**カラム構成は実体（ICS購読URL）に合わせて再定義**する。

```sql
CREATE TABLE office_calendar_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,                  -- users.id (bigint, 符号あり) と完全一致させる
  ics_url TEXT NOT NULL,                    -- openssl_encryptで暗号化して保存（google_calendar_tokensのトークンと同様の方式）
  display_label VARCHAR(255) NULL,          -- 任意のラベル（例:「会社の予定表」）。画面Bでの表示用
  last_fetched_at DATETIME NULL,            -- 直近のlist_events取得日時（デバッグ・タイムラグ説明表示用）
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_id (user_id),
  CONSTRAINT fk_oct_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

備考:
- `google_calendar_tokens`（`docs/sql/2026-08-15_google_calendar_tokens.sql`）と同じ命名・型規約（`user_id BIGINT`、`ON DELETE CASCADE`）を踏襲する
- 1ユーザー1連携（`UNIQUE KEY uq_user_id`）とし、再連携時は既存行をUPDATEする方針（Google版と同一）
- `access_token` / `refresh_token` / `token_expires_at` / `scope`カラムは不要（OAuthを使わないため）。代わりに`ics_url`（暗号化）と`display_label`を保持する
- `tasks`テーブルへの本機能用スキーマ変更は不要（Google版と同じ理由。重複防止の仕組みを持たせないため）

### 4.2 ICS購読URLの暗号化（確定: Google版と同一方式）

`ics_url`はPHPの`openssl_encrypt` / `openssl_decrypt`（AES-256-CBC）で対称鍵暗号化してDBに保存する。**このURLは事実上「認証情報」と同等の機密性を持つ**（知っている人は誰でも予定表を閲覧できるため）ため、Googleのアクセストークン/リフレッシュトークンと同じ扱いとする。

- 暗号化鍵は既存の`.env`環境変数 `WEBGANTT_TOKEN_ENCRYPTION_KEY` を**そのまま流用**する（Google連携用に新規発行済みの鍵と共用可、新規鍵の発行は不要）
- 保存形式: `base64(iv) . ':' . base64(ciphertext)`（`api/calendar_import.php`の`encryptToken()`/`decryptToken()`と全く同じロジックを流用する）

---

## 5. API設計

新規ファイル `api/office_calendar_import.php` を追加し、既存の`api/calendar_import.php`（Google版）と同じ`?action=xxx`ルーティングパターンを踏襲する。**OAuthコールバック用エンドポイントは不要**（Azure ADを使わないため）。

| メソッド | action | 説明 |
|---|---|---|
| GET | `status` | 現在ログイン中ユーザーのOutlook連携状態を返す（未連携/連携済み＋`display_label`） |
| POST | `connect` | リクエストボディ（JSON）に`ics_url`を受け取り、①URL形式の簡易検証、②実際にHTTP GETを試行し`text/calendar`系のレスポンスであることを確認、③問題なければ暗号化して`office_calendar_tokens`にupsert |
| POST | `disconnect` | 連携解除。該当ユーザーの`office_calendar_tokens`行を削除（外部への失効APIは存在しないため、DB削除のみ） |
| GET | `list_events` | クエリパラメータ`start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`でカスタム期間を指定。保存済み`ics_url`を都度HTTP GETし、ICS（vCalendar）データを`sabre/vobject`でパースして期間内の予定のみ抽出し**JSON形式でフロントエンドに返す**（DB書き込みはlast_fetched_at更新のみ）。サーバー側で`end_date - start_date <= 31日`を検証し、超過時は400エラー |

### 5.1 既存パターンとの整合

- `config.php`の`getDb()` / `sendJson()` / `sendError()` / `handlePreflight()` / `requireAuth()`をそのまま利用（Google版と同一）
- 暗号化ヘルパー（`encryptToken()` / `decryptToken()`）は`api/calendar_import.php`のロジックと同一実装を`office_calendar_import.php`内に複製する（共通化するなら`api/lib/crypto.php`等への切り出しも検討可だが、既存コードへの影響最小化のため、まずは複製方式を優先する）
- ICSパース処理には`sabre/vobject`（オープンソースPHPライブラリ、iCalendar/vCard RFC準拠のパーサー）を新規導入する
  - `api/composer.json`に`"sabre/vobject": "^4.5"`を追加
  - 本番サーバーでの`composer install`実行が必要（**ユーザー様側作業**）
  - 繰り返し予定（RRULE）の展開には`Sabre\VObject\Recur\EventIterator`を利用し、Google版の`singleEvents=true`相当の「個別インスタンスに展開」を実現する

### 5.2 `connect` action の検証フロー（新規・Google版にはない処理）

```
1. フロントエンドからPOST { ics_url: "https://..." }
2. サーバー側でURL形式チェック（https://で始まる、長さ上限チェック等）
3. file_get_contents() または curl でics_urlにGETリクエスト（タイムアウト10秒程度）
4. レスポンスのContent-Typeが text/calendar 系であることを確認
5. Sabre\VObject\Reader::read() でパース可能か検証（BEGIN:VCALENDARが含まれるか等）
6. 検証OK → 暗号化してoffice_calendar_tokensにupsert、成功レスポンス
   検証NG → 4xxエラーレスポンス（「連携に失敗しました」の趣旨のメッセージ）
```

### 5.3 `list_events` action の処理フロー

```
1. フロントエンドからGET ?start_date=...&end_date=...
2. office_calendar_tokensから該当ユーザーのics_url（暗号化済み）を取得・復号
3. ics_urlに都度HTTP GET（キャッシュはしない。Google版がaccess_token方式で
   都度APIを叩くのと同じ考え方。取得の都度Microsoft側の最新の公開データを取る）
4. Sabre\VObject\Reader::read()でパース
5. VEVENTを走査し、RRULE(繰り返し予定)がある場合はEventIteratorで
   指定期間内のインスタンスに展開
6. 各予定のSUMMARY（タイトル）・DTSTART・DTEND（終日/時刻指定を判定し
   日付部分のみ抽出）を取り出し、start_date〜end_date範囲内のもののみJSON化
7. last_fetched_atを現在時刻に更新
8. { events: [...] } をJSON返却（DB書き込みはlast_fetched_at以外行わない）
```

- HTTP取得やパースに失敗した場合は、Google版の「予定の読み込みに失敗しました。時間をおいて再試行してください」と同趣旨のエラーメッセージを返す

---

## 6. フロントエンドUI実装（`gantt-collab.html`）

### 6.1 既存モジュールとの統合方針

既存の「外部連携」モーダル（`docs/google-calendar-import-design.md` 4節、`gantt-collab.html`内の`#extCalOverlay`関連コード、約29968行目〜30740行目）に、**Officeカレンダー用の画面A〜Cを同一モーダル内の別ステートとして追加**する。

- モーダルのHTML構造（`#extCalOverlay` / `.ext-cal-modal` / `#extCalBody`）・CSSクラス（`.ext-cal-btn`, `.ext-cal-row`, `.ext-cal-event-list`等）はGoogle版と完全に共用する（新規CSSはICS入力フォーム用の最小限のみ追加）
- 内部状態管理は、現状の`_screenState`オブジェクトを「連携先種別（google/office）」で分岐できるよう拡張するか、または`_officeScreenState`として別変数を持たせるかは実装時に既存コードの構造を見て判断する（コアUI/UXへの影響を避けるため、既存の`_screenState`のフィールド構成は壊さない）
- 画面0（`renderScreen0()`）の「Officeカレンダー」項目のクリックハンドラを、`checkStatusAndRender()`のOffice版（例: `checkOfficeStatusAndRender()`）に差し替える
- API呼び出し先を`API_BASE`（Google用、`calendar_import.php`）とは別に、Office用の`OFFICE_API_BASE`（`office_calendar_import.php`）として新規定義する

### 6.2 タスク生成・追加処理（フロントエンドJS側）

Google版の`importGoogleCalendarEvents(events)`関数（`docs/google-calendar-import-design.md` 6.2節）と**全く同一のロジック**を、`importOfficeCalendarEvents(events)`として新規追加する（内部実装をコピーし、関数名とCOLLAB-HOOKの`subtype`のみ変更する想定）。

- `state.rows` / `state.tasks`への一括push、`window._ganttRender()`呼び出し、Undo履歴への追加はGoogle版と同一
- COLLAB-HOOKの`subtype`は`'calendar_import'`のまま共用してよいか、`'office_calendar_import'`として区別するかは実装時に決定する（区別する場合、`collab-client.js`側の受信処理に影響がないか要確認）

---

## 7. データマッピング

### 7.1 フィールドマッピング

| ICS（VEVENT）プロパティ | WebGanttタスク |
|---|---|
| `SUMMARY`（予定タイトル） | タスク名 |
| `DTSTART`（終日: `VALUE=DATE`／時刻指定: `DATE-TIME`、日付部分のみ抽出） | 開始日 |
| `DTEND`（同上） | 終了日 |
| （時刻情報） | 使用しない（無視、Google版と同一方針） |

補足: iCalendar仕様では終日イベントの`DTEND`も（RFC 5545上は）排他的（終了日の翌日を指す）ことが一般的なため、Google版の`end.date`と同様に**1日減算**する変換処理が必要（実装時に実際に取得したサンプルICSデータで検証する）。

補足2（繰り返し予定）: `RRULE`が存在するVEVENTは、`Sabre\VObject\Recur\EventIterator`で指定期間内の個別インスタンスに展開し、通常の単発予定と同一ロジックで一覧表示・インポートする（Google版の`singleEvents=true`相当）。

### 7.2 登録ロジック

Google版（`docs/google-calendar-import-design.md` 8.2節）と完全に同一：現在開いているプロジェクトの第0階層（最上位）にフラットな単一タスクとして追加。PHP側APIやDBへの直接書き込みは行わず、フロントエンドJS側で`state.rows`/`state.tasks`への一括pushとCOLLAB-HOOK（`state_sync`）経由の同期のみ。

### 7.3 重複防止（意図的に非実装）

Google版と同一方針。同一予定の複数回インポート防止・インポート済みマーキングは行わない。ICS購読は読み取り専用の公開データであり、書き込みは技術的に不可能なため、read-only厳守の設計方針にも自然に合致する。

---

## 8. エラーハンドリング方針

| ケース | 挙動 |
|---|---|
| `connect`時のURL検証失敗（形式不正・アクセス不可・text/calendar以外） | 「連携に失敗しました。URLが正しいか、Outlook側の公開設定が有効か確認してください」と表示し画面Aに留まる |
| `list_events`時のHTTP取得失敗（一時的なネットワークエラー等） | 「予定の読み込みに失敗しました。時間をおいて再試行してください」とエラーメッセージ表示（Google版と同一文言） |
| `list_events`時のICSパース失敗（Outlook側で公開設定が解除された等） | 「連携が無効になりました。再度連携してください」と表示し、画面Aへ戻す（Google版のリフレッシュトークン失効時と同様の扱い） |
| インポート実行時 | フロントエンドJS内処理のため、DB書き込み失敗という概念は存在しない（Google版8.2節と同一の理由） |

---

## 9. 開発・検証環境における手順とリスク最小化策

- 開発・検証はGoogle版と同じくメインサーバー（`https://ogma.mydns.jp/WebGantt/`）で実施
- リスク最小化策（Google版10節と同一方針）:
  - 実装中は機能フラグ等で通常利用者に見えない状態を維持し、検証完了後に画面0の「Outlookカレンダー（ICS連携）」行を有効化する
  - 既存ファイルへの変更は最小限（`gantt-collab.html`内の既存「外部連携」モジュールへの追記のみ、画面0のグレーアウト解除、新規関数群の追加）
  - ロールバック手順: 新規追加ファイル（`api/office_calendar_import.php`、新規DBテーブル`office_calendar_tokens`）を削除／`DROP TABLE`すれば旧状態に復元可能

---

## 10. 実機検証で確認済みの事実（2026-08-17実施）

1. Azure AD OAuth方式は、御社テナントの`risk-based step-up consent`ポリシーにより一般ユーザーの同意がブロックされ、「管理者の承認が必要」画面が表示されることを実機（ユーザーの会社アカウント、Azureポータル上のアプリ登録画面経由の認可URL）で確認
2. Outlook on the webの「予定表を公開する」機能自体は御社ポリシーでブロックされておらず、ICS購読URL（HTML/ICSの2種類のリンク）の発行に成功
3. 発行されたICS購読URLに対し、本サンドボックス環境（外部ネットワーク）からHTTP GETリクエストを実施し、以下を確認：
   - HTTPステータス: `200 OK`
   - `Content-Type: text/calendar; charset=utf-8`
   - サイズ: 163,560 bytes、`VEVENT`（予定）182件を含む有効なICSデータ
   - **実データの内容（予定のタイトル等）はサーバー側で一切表示・保存しておらず、件数と形式のみを確認した**

以上により、ICS購読URL方式が技術的に実現可能であることを確認済み。

---

## 11. 今後の実装ステップ

1. ~~方式調査・実機検証~~ → **完了**（本設計書2節・10節参照）
2. ~~設計書作成・ユーザー承認~~ → **完了**（2026-08-17）
3. ~~DBマイグレーションSQL作成~~ → **完了**（`office_calendar_tokens`テーブル、4.1節、`docs/sql/2026-08-17_office_calendar_tokens.sql`、本番サーバーで実行済み）
4. ~~`api/composer.json`へ`sabre/vobject`追加、本番サーバーでの`composer install`実行~~ → **完了**（ユーザー様側作業、実行確認済み）
5. ~~`api/office_calendar_import.php`実装~~ → **完了**（status/connect/disconnect/list_eventsの4アクション、5節。サンドボックス内単体テスト実施済み）
6. ~~フロントエンドUI実装~~ → **完了**
   - `gantt-collab.html`: 画面0の「Outlookカレンダー（ICS連携）」行の有効化、画面A（ICS入力フォーム、3.2節）・画面B/C（Google版流用）・新規関数`importOfficeCalendarEvents()`（6.2節）を実装
7. ~~実機での実際のOutlook予定表による疎通確認~~ → **完了（2026-08-17）**。12節参照
8. ~~ドキュメント更新・コミット・push~~ → **完了**（本節参照。コミット: `b3215cd`, `410f312`）

---

## 12. 本番デプロイ・実機動作確認（2026-08-17実施・完了）

### 12.1 実装コミット

| コミット | 内容 |
|---|---|
| `0e5b05e` | 本設計書の新規作成 |
| `b3215cd` | DBマイグレーションSQL、`api/composer.json`/`composer.lock`（`sabre/vobject`追加）、`api/office_calendar_import.php`新規実装、`gantt-collab.html`のUI実装、`collab/collab-client.js`のsubtypeラベル追加 |
| `410f312` | 下部ステータスバーのボタンUI改良（並び順・配色。本機能のバックエンド/フロントエンドロジックには変更なし。詳細は`collab/collab-client.js`のgit履歴を参照） |

### 12.2 本番サーバーでの反映作業（ユーザー実施・確認済み）

ユーザーが本番サーバー（`/media/HDD1_DATA/Web/WebGantt/`）で以下を実行し、「OKです」と確認済み：

1. `git pull` によるファイル反映（`office_calendar_import.php`、`gantt-collab.html`、`collab-client.js`、`composer.json`/`composer.lock`等）
2. `composer install --no-dev`（`sabre/vobject`, `sabre/uri`, `sabre/xml` の3パッケージインストール）
3. マイグレーションSQL（`docs/sql/2026-08-17_office_calendar_tokens.sql`）の`mysql`コマンドによる実行（`office_calendar_tokens`テーブル作成）

実行順序: **`git pull` → `composer install --no-dev` → `mysql`コマンドでSQL実行**（この順序で問題なく完了）。

### 12.3 実機動作確認結果（ユーザー実施・完了）

再発行されたICS購読URL（Outlook on the web「予定表の発行」機能経由）を用いて、本番環境（`https://ogma.mydns.jp/WebGantt/`）で以下の一連の動作を確認：

- ICS購読URLの登録（`connect`アクション）
- 実際のOutlookカレンダーの予定一覧取得（`list_events`アクション）
- ガントチャートへのデータ取り込み・タスクとしての反映

ユーザーコメント: 「問題なく、ICS登録と実際のOutlookカレンダーからのガントチャートにデータ読み取り〜反映までができました」

以上により、**Task C（Officeカレンダー連携: ICS購読URL方式）は実装・本番デプロイ・実機動作確認のすべてが完了した**。

### 12.4 参考情報: ICS購読URLの発行方法についての補足（ユーザー資料作成用、2026-08-17時点で調査・回答済み）

ユーザーから「ICS購読URLの発行は `outlook.cloud.microsoft`（Web版Outlook）でしか設定できないのか」との質問があり、以下の通り回答済み（ユーザー向け説明資料はユーザー側で別途準備するため、本リポジトリでの資料作成は行わない）：

- **Outlook on the web（Web版、`outlook.office.com`）**: 公式にサポートされる唯一の確実な方法。設定 → カレンダー → 共有カレンダー → 「カレンダーの発行」からICS形式のリンクを発行できる
- **new Outlook（Windowsの新Outlookアプリ）**: 内部的にOutlook on the webを組み込んだものであり、同じ発行手順が使える（実質①と同じ）
- **Outlook（classic、従来のWin32デスクトップ版）**: 「予定表をインターネットに発行」機能は存在するが、これが利用するOffice.com側の旧公開サービスは多くのMicrosoft 365テナントで既に無効化されており、動作が不安定（多くの環境でボタンがグレーアウトまたはエラーになる）。資料には推奨方法として記載しないことを提案
- **Outlookモバイルアプリ**: カレンダー発行機能自体が存在しない

このため、ユーザー向け資料には「ブラウザで `outlook.office.com` を開いて発行する」という手順を案内するのが最も混乱が少ない、との提案を行った。

---

## 13. 参考: 断念したAzure AD OAuth方式の記録（備忘）

将来、御社の組織ポリシーが変更された場合や、他の組織での展開時にAzure AD OAuth方式が使える可能性もあるため、実施した作業内容を備忘として記録する。

- 開発者個人のMicrosoftアカウント（`dtakedan@gmail.com`）でAzure無料アカウントを登録し、専用テナントを作成
  - テナントID: `7434326b-3db5-4032-aef8-5909334917f0`
  - プライマリドメイン: `dtakedangmail.onmicrosoft.com`
- 上記テナント上でAzure ADアプリを登録
  - アプリ名: `WebGantt Calendar Import`
  - クライアントID: `b0ff437f-8196-4907-a180-cdf001042e52`
  - サポートされているアカウントの種類: 「任意のEntra IDテナント + 個人用Microsoftアカウント」（マルチテナント）
  - リダイレクトURI: `https://ogma.mydns.jp/WebGantt/api/office_calendar_callback.php`（個人アカウントを許可する設定ではリダイレクトURIにクエリ文字列を含められない制約があり、専用ファイル名にする必要があった）
- `Calendars.Read`（委任、読み取り専用、Microsoft Graph公式リファレンス上は`AdminConsentRequired: No`）を追加
- 実機検証（ユーザーの会社アカウントで認可URLを開く）の結果、「管理者の承認が必要」画面が表示され、一般ユーザーの同意では完結しないことを確認 → **この方式は不採用**
- このアプリ自体は現状放置しても実害はないため、削除するかどうかは今後の任意判断とする
