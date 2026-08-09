# WebGantt — 協調編集ガントチャートツール

複数人で同時にタスクの追加・編集・削除ができる Web ベースのガントチャート。
ローカル HTML 版のマウス中心 UI/UX をそのまま踏襲し、サーバー側で協調編集・
通知・権限管理を提供する。

## 特徴

- リアルタイム同時編集(Socket.IO)
- タスク単位のロックによる競合制御
- @メンション / 遅延アラート / 開始・終了予告通知
- プロジェクト単位のメンバー・権限管理
- 管理者からのシステムアナウンス機能

## システム要件

- Apache 2.4+ (mod_proxy, mod_proxy_wstunnel, mod_headers, mod_rewrite)
- PHP 8.0+
- MySQL 8.0+ / MariaDB 10.6+
- Node.js 18+ (Socket.IO v4)
- Linux (Debian/Ubuntu で動作確認済み)

## クイックスタート

1. リポジトリを clone
2. `cp .env.example .env` して値を編集
3. `mysql -u root -p < sql/schema.sql` でスキーマ作成(初期化 SQL 一式)
4. `cd gantt-ws && npm ci --omit=dev`
5. Apache vhost サンプルを配置(`apache-conf/gantt-collab.conf`)
6. systemd unit を配置(`gantt-ws/gantt-ws.service`)
7. `sudo systemctl enable --now gantt-ws && sudo systemctl reload apache2`
8. ブラウザで `http://your-host:8080/WebGantt/login.html` にアクセス

## デプロイ先パスの切り替え

デフォルトは `/WebGantt/` 配下だが、`<base>` タグと `window.__APP_BASE__` を
書き換えるだけでパスを差し替え可能。

例: `/gantt/` 配下にデプロイしたい場合、以下 2 箇所を全 HTML で置換:

```html
<script>window.__APP_BASE__ = '/gantt/';</script>
<base href="/gantt/">
```

さらに Apache DocumentRoot 配下のディレクトリ名も変更し、既存絶対パス
`/WebGantt/…` も同時に `/gantt/…` に一括置換(`sed`)する。

## HTTPS 化(Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-apache
sudo certbot --apache -d your.example.com

# 発行後、.env を編集
#   WEBGANTT_SESSION_COOKIE_SECURE=true
sudo systemctl reload apache2
```

## ディレクトリ構成

- `WebGantt/` — フロントエンド + PHP API
  - `login.html` / `projects.html` / `account.html`
  - `gantt/gantt-v0770-collab.html` — ガント本体
  - `api/` — PHP API 群(`auth.php` / `projects.php` / `notifications.php` / …)
  - `collab/collab-client.js` — フロント側の協調クライアント
- `gantt-ws/` — Node.js WebSocket サーバー
- `apache-conf/` — Apache vhost サンプル
- `.env.example` — 環境変数テンプレート
- `.gitignore` — Git 管理除外
- `LICENSE` — MIT License

## 環境変数

主要な環境変数(`.env.example` 参照):

| 変数 | 意味 | 既定値 |
|---|---|---|
| `WEBGANTT_DB_HOST` | MySQL ホスト | `127.0.0.1` |
| `WEBGANTT_DB_PORT` | MySQL ポート | `3306` |
| `WEBGANTT_DB_NAME` | DB 名 | `gantt_collab` |
| `WEBGANTT_DB_USER` | DB ユーザー | `gantt_app` |
| `WEBGANTT_DB_PASS` | DB パスワード | (要設定) |
| `WEBGANTT_SESSION_LIFETIME` | セッション有効秒 | `604800`(7日) |
| `WEBGANTT_SESSION_COOKIE_SECURE` | Cookie の Secure 属性 | `false`(HTTPS では `true`) |
| `WEBGANTT_SESSION_COOKIE_SAMESITE` | Cookie の SameSite 属性 | `Lax` |
| `PORT` | Node WS ポート | `3001` |
| `CLIENT_ORIGIN` | Node WS の CORS 許可オリジン | `*` |

`WEBGANTT_DB_*` が未設定の場合、旧来の `DB_*` 変数(Node WS 側と共通)を
第2フォールバックとして参照する。

## ライセンス

このソフトウェアは MIT License の下で配布されています。
詳細は [LICENSE](./LICENSE) ファイルを参照してください。

Copyright (c) 2026 takeda

## 貢献

Issue / Pull Request 歓迎。実装前に設計を Issue 上で提案してから
実装に入るスタイルを推奨します(実装前に必ず設計提示→合意→実装)。
