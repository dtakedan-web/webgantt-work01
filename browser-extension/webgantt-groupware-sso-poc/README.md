# WebGantt Groupware SSO PoC(検証用・使い捨て)

新規タスク②(社内グループウェア[intra-mart Accel Collaboration]連携)の設計調査の一環として、
「拡張機能自身が裏側で直接HTTP通信し、Windows統合認証(SSO)によるgwlogin経由の自動ログインが
成立するか」を検証するための、**使い捨てのテスト用Chrome拡張機能**です。

- WebGantt本体(`gantt-collab.html`)には一切関与しません。
- 検証が完了し、正式な拡張機能(仮称: `webgantt-groupware-importer`)の実装に進む段階になったら、
  このディレクトリは削除する想定です。

## 検証したいこと

1. **Step① SSOログイン**: `http://suzumo.local/gwlogin` に拡張機能のfetch()でアクセスした際に、
   Windows統合認証によるリダイレクト(`gwlogin` → `gwlogin/` → `certification?im_user=...`)が
   自動的にたどられ、intra-martの認証Cookie(`jp.co.intra_mart.session.cookie`, `JSESSIONID`)が
   ブラウザに発行されるか。
2. **Step② ホーム画面アクセス**: ①のCookieを使って `http://imap01.suzumo.local/imart/home` の
   HTMLが(ログイン画面ではなく)正しく取得できるか。
3. **Step③ スケジュールAPI**: `POST .../collaboration/schedule/user/calendar/find_group_week` を
   叩いて、週間スケジュールのJSONが取得できるか。

## 使い方

1. Chromeの拡張機能管理ページ(`chrome://extensions`)で「デベロッパーモード」をON
2. 「パッケージ化されていない拡張機能を読み込む」で本フォルダ(`webgantt-groupware-sso-poc`)を選択
3. 社内LANに接続したPC上のChromeで、拡張機能アイコンをクリックしてポップアップを開く
4. 「① SSOログインを試す」ボタンを押す → 結果(成功/失敗、発行されたCookie名など)が表示される
5. 成功したら「② ホーム画面を取得」→「③ スケジュールAPIを試す」を順に実行
   - ③では、Chrome DevToolsのNetworkタブで確認した`find_group_week`のPayload(リクエストボディ)の
     内容をテキストボックスに貼り付けてから実行してください(空欄でも試すことは可能です)

## 注意事項

- `http://`(平文)での通信を行います。社内LAN限定の利用を前提としています。
- `manifest.json`の`host_permissions`は `suzumo.local` と `imap01.suzumo.local` のみに限定しています。
- ID・パスワードは一切保存しません(Windows統合認証によりブラウザが自動的に処理する前提)。
- この検証がうまくいかない場合は、フォールバックとして「ID/パスワードを拡張機能内に保存し、
  `certification?im_user=...&im_password=...` に直接アクセスする方式」を再検討します。
