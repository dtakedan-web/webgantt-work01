# 【別チャット貼り付け用】グループウェアSSO連携ツール開発プロンプト

以下の区切り線から区切り線までの内容を、新しいチャットの最初のメッセージとしてそのまま貼り付けてください。

---

私は社内グループウェア「intra-mart Accel Collaboration」（NTTデータ社製、社内LAN限定）と連携するツールを新規に作成したいと考えています。これはWebGanttとは全く別の、新規プロジェクトです。

以前、別のプロジェクト（WebGantt）で、このグループウェアへの「Windows統合認証（SSO）による自動ログイン〜スケジュール情報取得」を実現するブラウザ拡張機能を開発し、実機で動作確認済みです。今回はその際に得た技術情報（ログイン方式・API仕様・データ加工ロジック）を流用し、開発の重複を避けたいと考えています。

## 実証済みの技術情報

### 1. 対象システム

- 製品名: intra-mart Accel Collaboration（社内LAN限定、Windowsドメイン参加済みの社内PCからのみアクセス可能）
- 主要ホスト（実例）:
  - `http://suzumo.local/gwlogin` — SSOログイン用の別ドメイン（ASP.NET/IIS基盤）
  - `http://imap01.suzumo.local/imart/` — グループウェア本体

### 2. SSO自動ログインの仕組み（ID・パスワード保存不要）

「タブに何かを注入する」のではなく、**HTTPクライアント自身（ブラウザ拡張機能のfetch等）が、
ブラウザ標準のネットワークスタック（NTLM/Windows統合認証込み）を素通しで使って直接
グループウェアサーバーと通信する**方式が有効であることを実証済みです。

以下の3段階のリクエストを`fetch(url, {credentials:'include', redirect:'follow'})`で
実行するだけで、ログインが完結します（1回の呼び出しでリダイレクトが自動的に完結する）。

| # | リクエスト | レスポンス |
|---|---|---|
| ① | `GET http://suzumo.local/gwlogin` | `301` → `Location: http://suzumo.local/gwlogin/` |
| ② | `GET http://suzumo.local/gwlogin/` | `302` → `Location: http://imap01.suzumo.local/imart/certification?im_user=<ID>&im_password=<値>`（**ID/パスワードはリクエストに一切含まれない**。Windows統合認証(NTLM)によりサーバー側が自動判定し、リダイレクト先URLに埋め込んで返す） |
| ③ | `GET http://imap01.suzumo.local/imart/certification?...` | `200 OK` + `Set-Cookie: jp.co.intra_mart.session.cookie=...; HttpOnly` + `Set-Cookie: JSESSIONID=...` |

サンプルコード（概念コード）:
```javascript
async function ensureSsoLogin() {
  const resp = await fetch('http://suzumo.local/gwlogin', {
    method: 'GET',
    credentials: 'include',
    redirect: 'follow',
  });
  if (!resp.ok) throw new Error('SSOログイン失敗: status=' + resp.status);
  return true; // この時点でセッションCookieが発行済み
}
```

Chrome・Edge両方の実機でこのフローの成功を確認済みです。

### 3. スケジュール取得API（`find_group_week`）

ログイン確立後（Cookie有効な状態）、以下のAPIで週間スケジュールを取得できます。
これはintra-martの「グループスケジュール（週表示）」画面が内部的に呼び出しているJSON APIです。

```
POST http://imap01.suzumo.local/imart/collaboration/schedule/user/calendar/find_group_week
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest
X-jp-co-intra-mart-ajax-request-from-imui-form-util: true
Cookie: jp.co.intra_mart.session.cookie=...; JSESSIONID=...

Body: view=groupWeek&displayDate=YYYYMMDD&target=&page=1
```

- `displayDate`は対象週の**日曜日**の日付（`YYYYMMDD`）。未指定なら今週。複数週取得は±7日ずつ変えて複数回呼び出す
- レスポンスは `{ error: false, data: { schedules: [[...],[...],...], title, dayInfos } }` という形式で、
  `schedules`は**ユーザー単位の配列の配列**（複数人参加の予定は複数配列に重複出現するため`scheduleKey.code`でのユニーク化が必須）
- 予定オブジェクトの主要フィールド: `title`, `start`/`end`, `eventDate`, `allDay`, `scheduleKey.code`,
  `type`（`"EVENT"`=個人終日予定 or `"SCHEDULE"`=会議）, `targetInfo.name`/`targetInfo.code`（所有者情報）,
  `startDateString`/`endDateString`（`["yyyy/mm/dd","H:mm"]`形式）

### 4. データ加工ロジック（参考実装）

- **ユニーク化**: `scheduleKey.code`をキーに`Map`で重複排除
- **除外ルール**: 用途に応じて、特定キーワード（例:「フレックス」）を含む終日予定を除外する等のフィルタを実装可能
- **連続日結合**: 同じ担当者・同じタイトルの終日予定が複数日連続する場合、営業日ベース
  （土日を挟んでも連続とみなす。金曜→翌週月曜も連続）で1本のタスクに結合するロジックを実装済み

### 5. Manifest V3拡張機能としての構成（実証済みの型）

```json
{
  "permissions": ["storage", "cookies"],
  "host_permissions": [
    "http://suzumo.local/*",
    "http://imap01.suzumo.local/*"
  ]
}
```

Content Script（ページへのJS注入）は一切不要。ポップアップ内の`fetch()`だけで
ログイン〜データ取得が完結します。

## 依頼したいこと

上記の実証済み技術情報をベースに、以下の要件で新規ツールを開発してほしいです。

（※ここに、今回作りたい新規ツールの具体的な要件・用途・出力先などを記入してください。
例: 「取得したスケジュールをCSV出力したい」「別のシステムに自動転記したい」
「特定の条件で集計・通知したい」等）

---

## 補足（別チャット側での作業開始にあたって）

- 上記のログイン方式・API仕様は**実機で動作確認済み**の情報です。ただし実際のホスト名
  （`suzumo.local`等）は環境固有のため、新しいツールの対象環境で実際に有効かどうかは
  改めて確認してください。
- 除外ルール・結合ロジックはWebGantt向けの要件に基づくものなので、新規ツールの用途に
  応じてカスタマイズしてください。
- 通信はすべて平文HTTP（`http://`）です。社内LAN限定のシステムという前提のためですが、
  新しい環境・用途に応じて再検討してください。
