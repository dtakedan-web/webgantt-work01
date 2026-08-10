# Webガントチャート開発コンテキストファイル

- **作成日**: 2026-08-09
- **用途**: AIコードエディタ(Claude Code等)でガントチャートの改良作業を行うための初期コンテキスト

---

## 1. 絶対に守る開発方針

以下は「開発の前提.md」に記述された必須事項です。すべての作業で厳守してください。

### ローカルガントチャートツール

- 基本的にひとつのファイル内で完結させる。複数ファイルに分けない
- 機能の実装前に必ず設計を提示 → ユーザー確認 → 実装の順序を守る

### Webガントチャートツール

- **ローカルガントチャート(コア)部分のUI/UXは決して弄らない**: ガントチャート本体(`gantt-collab.html`)の既存ポップオーバー・ダイアログ・ツールバーの中身は変更禁止
  - ローカルガントチャートの機能アップ・バグフィックスがあった時かつユーザーが許可する時のみ、更新を行ってよい。ただし、実装はユーザーに確認してから実装の順序を守る
- **Webガントチャートの追加機能はすべて「最下バー」か「別ページ」へ**: 追加UIはすべて最下バー新設ボタンか、`projects.html`等の別ページに実装する
- **既存ポップオーバーへの追加もNG**: `settingsPopover`(歯車ポップオーバー)への追加も禁止
- **機能の実装前に必ず設計を提示 → ユーザー確認 → 実装の順序を守る**

---

## 2. プロジェクト概要

### ローカルガントチャート

- ファイル: `gantt-v0771.html`(27,811行・単一HTML)
- スタンドアロン・ブラウザ単体で動作・サーバー不要
- 内部`APP_FILE_VERSION = 'v0770'`(L7356)・UI表示`Ver.0.7.70`
- 2つのIIFE構成: メイン(L7177〜L25515) + 注記(L25516〜L27806)

### Webガントチャート(協調編集版)

- ファイル: `gantt-collab.html`(30,492行・ファイル名固定化済み)
- ローカル版を内包 + 協調編集機能(Socket.IO・ロック・プレゼンス・通知)を追加
- 内部`APP_FILE_VERSION = 'v0771'`
- 追加ファイル: `collab/collab-client.js`(Socket.IOクライアント) + PHP REST API + MySQL DB + Node.js WebSocketサーバー

### サーバー構成


| 環境  | サーバー             | URL                                         | 用途     |
| --- | ---------------- | ------------------------------------------- | ------ |
| 本番  | メイン(192.168.1.3) | `https://ogma.mydns.jp/WebGantt/`           | 公開・実運用 |
| 開発  | サブ(192.168.1.2)  | `http://192.168.1.2:8080/WebGantt/`(LAN内のみ) | 開発・検証  |


### メインサーバーのファイル配置

```
/media/HDD1_DATA/Web/WebGantt/
└── gantt/
│   └──gantt-collab.html              ガントチャート本体
├── login.html                     ログイン画面
├── projects.html                  プロジェクト管理画面
├── account.html                   アカウント設定画面
├── api/                           PHP REST API
│   ├── config.php                 共通設定・認証ヘルパー
│   ├── auth.php                   認証API
│   ├── projects.php               プロジェクト管理API
│   ├── notifications.php          通知API
│   ├── health.php                 ヘルスチェック
│   ├── user_view_settings.php     ビュー設定API
│   ├── MailSender.php             メール送信クラス
│   ├── send_daily_emails.php      日次メール送信cron
│   ├── .env                       cron実行用環境変数(chmod 600)
│   └── vendor/                    PHPMailer(composeにてインストール)
└── collab/
       └── collab-client.js           協調編集クライアント

/opt/gantt-ws/
├── server.js                      WebSocketサーバー
├── package.json
└── node_modules/

/etc/systemd/system/gantt-ws.service  systemd unit
/etc/apache2/sites-available/default-ssl.conf  Apache HTTPS設定
```

---

## 3. COLLAB-HOOK同期の仕組み(重要)

ガントチャート本体(`gantt-collab.html`)でタスクの状態変更を行った後、`render()`の後に**必ず**`COLLAB-HOOK`を発火してください。発火しないと相手側に同期されません。

```javascript
// 関数の末尾(render()の後)に追加:
document.dispatchEvent(new CustomEvent('gantt:op', { detail: { op: 'state_sync', subtype: '機能名', snapshot: JSON.parse(buildSerializableProject()) }}));
```

主な`COLLAB-HOOK`の種類:

- `promote` / `demote`: 単一タスク階層変更
- `multi-promote` / `multi-demote`: 複数タスク階層一括変更
- `restore`: アーカイブ復元

---

## 4. 引き出し線注記のanchorColとviewStartの関係(重要)

注記のアンカー位置は`anchorCol`(viewStartからの相対日インデックス)で保存されます。リモートスナップショット受信時に`_applyRemoteDataOnly`で復元する際、送信者と受信者でviewStartが異なる場合は`anchorCol`をシフトする処理が入っています。新しい注記関連の処理を追加する場合は、この仕組みを考慮してください。

---

## 5. バージョン更新時の変更箇所

バージョンを更新する際は以下を変更:

1. **ファイル名**: `gantt-collab.html`は固定名(変更しない)
2. **`APP_FILE_VERSION`**(L7471付近): 保存JSONの`version`フィールドに影響
3. **UI表示の初期値**(L7108付近・L7170付近): `helpVersionValue`と`versionInfoValue`
4. **保存JSONの`version`フィールド**(L22434付近): 構造を変えない場合はそのまま

---

## 6. 既知の制約


| 項目                | 説明                               |
| ----------------- | -------------------------------- |
| localStorage不使用   | 設定はプロジェクトJSON内に保存・ブラウザ終了で未保存分は消失 |
| 階層の深さ             | 上限なし・レベル0以上の整数                   |
| フォント太さ            | レベル0-2のみCSS定義・レベル3以上はlevel-2と同じ  |
| Cloudflare beacon | ファイル末尾に2つ挿入・ローカルでは動作しない          |
| ドラッグ移動            | 単一タスクのみ・複数選択中のドラッグ移動は不可          |
| 依存矢印              | FS型のみ・右ボタンドラッグで作成                |


---

## 7. これまでの修正履歴


| 日付         | 内容                                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| 2026-08-08 | v0771改良反映: 複数タスク階層一括操作追加・ファイル名を`gantt-collab.html`に固定化                           |
| 2026-08-08 | 同期不具合修正: `promoteMultiTaskHierarchy`/`demoteMultiTaskHierarchy`に`COLLAB-HOOK`を追加 |
| 2026-08-09 | 引き出し線注記ズレ修正: `_applyRemoteDataOnly`の注記復元でviewStart差分を`anchorCol`にシフト             |
| 2026-08-09 | 遅延赤枠ズレ修正: ペイン境界ドラッグ時に`updateDelayedRowRightBorders()`の呼び出しを追加                    |


---

## 8. 詳細資料への参照

より詳細な情報はセカンドブレイン内の資料を参照:

- `0A_ツール資料(ローカルガントチャート)/`: ローカル版の全資料(資料A00〜A12)
- `0B_ツール資料(Webガントチャート)/`: Web版の全資料(資料B00〜B08)
  - 資料B02: システム説明\_全コンポーネント詳細
  - 資料B08: メンテナンスガイド\_トラブルシューティング(更新履歴含む)

---

## 9. 作業時の注意

1. **実際のコードを読んでから修正する**: 推測で記述しない。必ず該当箇所のコードを確認する
2. **存在しない機能を記述しない**: コード上に存在しない機能は実装しない
3. **UI/UXを変えない**: 既存のポップオーバー・ダイアログ・ツールバーの中身は変更禁止
4. **COLLAB-HOOKを忘れない**: 状態変更関数の`render()`の後に`gantt:op`イベントを発火する
5. **両方のファイルに反映**: コア部分の変更は`gantt-v0771.html`(ローカル)と`gantt-collab.html`(Web)の両方に反映する

---

## 10. GitHubコミットメッセージの形式(2026-08-10追加)

すべてのコミットメッセージは以下の形式でまとめる:

```
【修正ファイル】XXX
【修正内容】XXX
```

- 複数ファイルを修正した場合は改行で列記する
- 修正内容は簡潔に要点をまとめる(詳細な背景説明は本文下部に補足として続けてよい)

&nbsp;