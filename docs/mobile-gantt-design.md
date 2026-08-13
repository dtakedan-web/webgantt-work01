# WebGantt モバイル対応 設計書（gantt-mobile.html）

- 作成日: 2026-08-10
- 対象: スマートフォン・タブレット向け専用ページの新規追加
- 前提: `WebGantt開発コンテキスト.md` の全ルールに従う（`gantt-collab.html` のコアUI/UXは変更しない。本設計はそれとは別の新規ファイルを追加するもの）

---

## 1. 基本方針

- `gantt-collab.html`（PC版・コア）は**一切変更しない**。
- 新規ファイル `gantt/gantt-mobile.html` を作成し、`gantt-collab.html` の「描画ロジック・見た目」は**コピーして流用**、「操作方法（右クリック/右ドラッグ前提の部分）」と「機能スコープ」のみモバイル向けに削減・再設計する。
- ゼロからの再構築は行わない（右ペインのExcel風グリッド表現・依存矢印描画は複雑な座標計算ロジックであり、移植の方が品質・コストの両面で優位と判断／既に合意済み）。
- バックエンド（DB・API・WebSocket/Socket.IO）は**完全に既存のものを共用**する。認証はセッションクッキー方式でページ名に依存しないため、追加改修なしで利用可能。
- 新規に追加するモバイル専用のPHP/JSファイルが必要になった場合は、ファイル名に `-mobile` サフィックスを付ける（例: `xxx-mobile.php`）。既存のPC専用バックエンドファイルは無変更。

---

## 2. 機能スコープ

### 2.1 残す（コピーしてそのまま移植する）機能

| 機能 | 対応するPC版のコード | 備考 |
|---|---|---|
| 右ペインのExcel風グリッド表示 | `renderTimeline()`, `buildBar()`, `buildPartialBar()`, `buildActualBar()` (12830〜12903行目 等) | 座標計算含め丸ごと移植 |
| 依存関係の矢印描画 | `renderDependencies()`, `buildDependencyPathD()`, `ensureDependencyDefs()` (11237行目〜) | 経路計算ロジックも含め丸ごと移植 |
| 今日の線・週末ハイライト・月表示ガイド | `renderTodayLine()`, `renderMonthViewGuideSegments()` | 移植 |
| タスク階層の折りたたみ（⊖/⊕の丸キャレットボタン） | `getHierarchyCaretSvg()`, `row.collapsed` 関連一式 (10884, 12036〜12089行目 等) | タップ操作のみで完結。**削らない** |
| 左ペイン列幅の折りたたみ（`−`/`+`ボタン） | `leftPanePrimaryToggleBtn` / `leftPaneSecondaryToggleBtn` (5667, 5672, 11802〜11823行目) | 3段階の列幅プリセット切替。**削らない** |
| 日付ピッカー（カレンダー）`#calendarPopover` | `openCalendar()`, `hideCalendar()`, `renderCalendar()` 等 (22340行目〜) | ◀▶×閉じる・日付削除ボタンのレイアウト含め丸ごと移植。ユーザー設定内・左ペインの開始日終了日セルの双方から呼ばれる共通部品 |
| `#settingsPopover`（ユーザー設定・歯車アイコン） | 6424〜6508行目 | 開発ルールにより**変更禁止**。ポップオーバーの内容はそのまま移植。呼び出し元のボタン（`settingsBtn`）は統合メニュー内に配置する（3節参照） |
| 共同編集・プレゼンス表示・遅延インジケーター | `collab-client.js` の該当箇所、遅延行の右ボーダー処理等 | そのまま利用 |
| Undo/Redo | `undoBtn` / `redoBtn` | 残す |
| プロジェクト名編集 | `projectTitleBtn` | 残す |
| ステータスバッジ・メモ機能 | `buildStatusCell()`, メモバブル | 残す |

### 2.2 削る機能

| 機能 | 対応するPC版のコード | 削除理由 |
|---|---|---|
| アーカイブ | `archiveBtn` | モバイルでは使用頻度低・操作が複雑 |
| 引き出し線注記モード | `annotationModeBtn` | 複雑な配置操作が前提でタッチ向きでない |
| 印刷 | `printBtn` | モバイルでは非対象 |
| ファイルを開く／保存／名前を付けて保存 | `openBtn`, `saveBtn`, `saveAsBtn` | サーバー保存方式のため不要（自動保存＋協調編集で代替） |
| メニュー内: システム設定・カレンダー設定・プリセット設定・色設定 | `moreSystemSettingsBtn`, `moreCalendarSettingsBtn`, `morePresetSettingsBtn`, `moreColorSettingsBtn` とその先の各ダイアログ (6554〜6764行目) | 詳細なカスタマイズ設定はPC版に集約し、モバイルはシンプルな閲覧・編集に絞る |
| メニュー内: タスクのエクスポート/インポート、ヘルプ、バージョン情報 | `moreExportTasksBtn`, `moreImportTasksBtn`, `moreHelpBtn`, `moreVersionBtn` | モバイルでの利用頻度低 |
| 右クリックによる矢印（依存関係）新規作成・複数選択削除 | `handleDependencyContextMenu`, `event.button === 2` 依存部分 (19422, 19473行目 等) | タッチデバイスに右クリックは存在しないため |
| 右クリックのコンテキストメニュー（階層操作: 切り取り/コピー/今日に移動等） | `#contextMenu` (6307行目〜), `handleLeftContextMenu` | 同上 |
| 年表示・週表示 | `yearViewBtn`, `weekViewBtn` | 表示は月・日のみに限定 |
| 検索機能 | `searchBtn` | 初期スコープでは対象外（将来的に別途検討） |

### 2.3 改修する機能（代替UIで再実装）

| PC版の機能 | モバイルでの代替 |
|---|---|
| 右ドラッグでの依存矢印作成 | タスクバーの長押し（ロングタップ）でモード切替 → タップで対象タスクを選択、という2段階操作に置き換え |
| 右クリックコンテキストメニュー（階層操作） | タスク行の長押しで簡易操作シート（ボトムシート等）を表示し、同等の操作（子タスク追加・切り取り・コピー・今日に移動）を提供 |
| ユーザー設定（歯車）／ログアウト／アカウント管理／プロジェクト管理／通知／プロジェクト切替（`settingsBtn`、`#collab-status-bar`内に個別配置） | 1つの統合メニューにまとめて集約（詳細は3節参照） |
| 「今日」ボタン（`todayBtn`） | 削除。タイムライン上部の日付ヘッダー（月/日/曜日表示部分）のダブルタップで「今日」付近へ移動する操作に置き換える（詳細は7節参照）。「前へ（`<<`/`<`）／次へ（`>`/`>>`）」ボタン（`prevBtn`, `prevDayBtn`, `nextDayBtn`, `nextBtn`）は現状維持（削除しない） |
| SVGアイコンの画像ボタン（base64埋め込み） | 全てテキストラベルボタンに置き換え（ファイルサイズ削減・タッチ視認性向上） |

---

## 3. 画面レイアウト方針

- **左ペイン中心の編集モデル**: タスク名・開始日・終了日・実働日・ステータスの編集を主とし、右ペインは主に確認用（視覚的な進捗把握）として扱う。
- 左ペインの列幅折りたたみ機能（`−`/`+`ボタン）はそのまま残し、画面幅に応じて初期状態を調整する（モバイルではデフォルトで圧縮状態にする等、CSSまたは初期化ロジックで対応。ボタン自体の機能は変更しない）。
- **ツールバーは1段（上段のみ）に統合する**。タスク表示領域（左ペイン・右ペイン）を少しでも広く確保するため、PC版にあった上段（トップバー）と中段（ツールバー）の2段構成を廃止し、1段にまとめる。
- 「前へ（`<<`）／今日／次へ（`>>`）」ボタンは削除する。右ペインの日付エリアを左右にスワイプすることで表示期間を移動する操作に置き換える（実装詳細は今後のUI実装時に確定）。将来的に、右ペインの日付エリアをダブルタップすると「今日」付近へ移動する機能を追加する想定（初期リリースのスコープには含めない）。

### 統合した上段の項目（順番と内容）

1. プロジェクト名
2. Undo / Redo
3. 月表示／日表示の切替
4. 統合メニュー（以下をまとめる）
   - ユーザー設定（歯車、`#settingsPopover`を開く）
   - アカウント管理
   - プロジェクト管理
   - ログアウト
   - 通知
   - プロジェクト切替

- 表示スケールは「月表示」「日表示」の2つのみ（変更なし）。

---

## 4. ファイル構成

```
webapp/
  gantt/
    gantt-collab.html      ← 無変更（PC版コア）
    gantt-mobile.html      ← 新規追加（本設計対象）
  collab/
    collab-client.js       ← 既存を可能な限りそのまま再利用（ページ名非依存）
  login.html                ← redirectToGantt() にデバイス判定ロジックを追加
```

- `gantt-mobile.html` は `gantt-collab.html` をベースにHTML/CSS/JSをコピーし、上記2.2の削除対象要素・関数を取り除く形で作成する。
- `collab/collab-client.js` は、`#collab-status-bar` のUI生成部分（`UI.init()`, 1285行目〜）がモバイルのレイアウトと衝突する場合のみ、必要最小限の分岐またはモバイル専用の初期化オプションを追加する。大規模な改修が必要と判明した場合は `collab-client-mobile.js` として別ファイル化を検討する（現時点では既存ファイルの流用を優先）。
- 新規バックエンドファイルが必要になった場合は `-mobile` サフィックスを付与する。現時点では、認証・プロジェクトAPI・WebSocketは既存のものを流用できる見込みで、新規バックエンドファイルの必要性は低いと想定。

---

## 5. デバイス判定・ルーティング（Task #4・実装済み）

- `login.html` の `redirectToGantt()`（171〜200行目付近）に、モバイル/タブレット判定を追加した。
- 判定方法【確定】: `navigator.userAgent` による判定（Android/iPhone/iPod/BlackBerry/IEMobile/Opera Mini + クラシックiPad UA）に加え、iPadOS 13以降がUAを"Macintosh"と偽装する問題への対策として `navigator.maxTouchPoints > 1` とのAND判定を併用する。`window.matchMedia`やウィンドウ幅によるビューポート判定は**採用しない**（ログイン時の一度限りの遷移判定であり、PCブラウザのウィンドウを狭めただけでモバイル版に遷移させたくないため。ユーザー確認済み、2026-08-11）。
- 判定関数 `isMobileOrTabletDevice()` は `collab/device-detect.js` に切り出し、`login.html` から `<script src="/WebGantt/collab/device-detect.js"></script>` で読み込む。`login.html`/`projects.html`/`account.html`は元来共有JSファイルを持たない自己完結ページ群だが、将来`projects.html`/`account.html`の「ガントチャートへ戻る」リンク（現状`gantt-collab.html`固定）にも同じ判定が必要になる可能性が高いと判断し、単一のソースオブトゥルースとして共有ファイル化した（ユーザー確認済み、2026-08-11。この時点では`projects.html`/`account.html`自体の改修は未着手・スコープ外のまま）。
- 判定がモバイル/タブレットの場合は `gantt-mobile.html` へ、それ以外（PC）は `gantt-collab.html` へ遷移させる。`redirectToGantt()`内の3つの遷移先URL構築箇所（`project`パラメータ利用時／`action=loginProject`のAPI結果利用時／フォールバック時）全てで、ファイル名部分のみを変数`ganttFile`で分岐させた。
- URLパラメータ（`redirect`/`project`）や `action=loginProject` によるプロジェクト解決ロジック、`?logout=1`処理、既存ログイン済み判定（`/me` API呼び出し後の自動`redirectToGantt()`呼び出し）は変更していない。`redirect`パラメータ分岐（既に完全なURLを含む）は本判定の対象外のまま素通しとする。
- Playwright（Pixel 5 / iPhone 13 / iPad(gen7) / iPadOS13+偽装UA+マルチタッチ / 通常のデスクトップUA・Mac実機相当UA無タッチの計6パターン）で`isMobileOrTabletDevice()`の判定結果を検証、また`redirectToGantt()`の3分岐×モバイル/PC双方（`redirect`透過・`project`パラメータ・API経由`targetProject`・フォールバックの計7ケース）で実際の遷移先URLを検証し、全てのケースで期待通りの動作を確認済み。ユーザーの実機でも問題なく振り分けられることを確認済み（2026-08-11）。

### 5.1 projects.html / account.html の「ガントチャートへ戻る」リンク対応（Task #4追加分・実装済み）

- Task #4実装当初はスコープ外としていた`projects.html`/`account.html`の「ガントチャートへ戻る」リンク（`gantt-collab.html`固定）についても、5節の共有ファイル`collab/device-detect.js`を再利用する形で追加対応した（ユーザー確認済み、2026-08-11）。
- 両ファイルに`<script src="/WebGantt/collab/device-detect.js"></script>`を追加し、`init()`冒頭で`const GANTT_FILE = isMobileOrTabletDevice() ? 'gantt-mobile.html' : 'gantt-collab.html';`を算出。
- 修正箇所（計5箇所、2ファイル）:
  - `projects.html`／`account.html`：静的HTMLの`<a id="backToGanttLink" href="/WebGantt/gantt/gantt-collab.html">`（JS実行前の一瞬だけ表示される初期値。`init()`側で必ず上書きされる）。
  - `projects.html`／`account.html`：`init()`内、`sessionStorage.gantt_last_project`の有無に応じて`backLink.href`を動的に設定する箇所。**変更点**：従来は`gantt_last_project`が無い場合は静的HTMLの値（PC固定）のまま何もしなかったが、修正後は`gantt_last_project`の有無に関わらず必ず`GANTT_FILE`で上書きするようにした（`project`パラメータは値がある場合のみ付与）。これにより、直前に開いていたプロジェクトの情報が無い場合でも常に端末に応じたファイルへ遷移する。
  - `projects.html`：プロジェクト一覧テーブルの各行、プロジェクト名リンク（`project-name-link`、該当プロジェクトを直接開く）の`ganttUrl`構築箇所もファイル名部分を`GANTT_FILE`に変更。
- `sessionStorage.gantt_last_project`の読み書きロジック自体（`collab-client.js`側での設定・削除処理）は変更していない。
- Playwright（`projects.html`/`account.html`それぞれについて、モバイル(iPhone13/Pixel5)・PCの2端末×`gantt_last_project`あり/なしの計4パターン、合計8ケース）で、「ガントチャートへ戻る」リンクおよびプロジェクト一覧の直接リンクが正しいファイル名・`project`パラメータを持つことを検証し、全ケースで期待通りの動作を確認済み。

### 5.2 プロジェクト切替メニューの表示位置改良（Task #5・実装済み）

- **不具合の原因**: `#collab-switch-menu`（プロジェクト切替のドロップアップメニュー）は、PC版のステータスバー最下段に表示される`#collab-switch-btn`の`getBoundingClientRect()`を基準に位置（`left`）を計算し、`position:fixed; bottom:28px`で下部に貼り付ける実装になっていた。モバイル版では下部ステータスバー自体が`display:none`（機能はハンバーガーメニュー内の`#mobileMenuSwitchBtn`から`proxyClick()`経由で委譲）のため、`switchBtn`の座標がほぼ0（画面左下端相当）になり、メニューが画面左下端に貼り付いて表示される不具合となっていた。
- **対応方針【確定・A案】**: 通知パネル（`#notif-panel`/`#notif-overlay`）と全く同じUXに統一する。モバイル版（`_isMobilePage===true`）では、画面全体を暗くする背景オーバーレイ`#collab-switch-overlay`（`position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:100000`）を新設し、`#collab-switch-menu`自体も`position:fixed; left:50%; top:50%; transform:translate(-50%,-50%)`による画面中央固定表示に変更した（`z-index:100001`は変更なし）。オーバーレイの背景部分をクリックするとメニューが閉じる（通知パネルと同じ挙動）。PC版（`_isMobilePage===false`）は、`switchOverlay`自体を生成せず、既存の位置計算ロジック（`switchBtn.getBoundingClientRect()` + `bottom:28px`の左下ドロップアップ）を1バイトも変更していない。ユーザーは提示した2案（A案：オーバーレイ＋中央表示／B案：中央表示のみ・オーバーレイなし・既存の外側クリックのみで閉じる）のうち「A案でお願いします．」と承認（2026-08-11）。
- **修正箇所**: `collab/collab-client.js`の「プロジェクト切替ボタン＆ドロップアップメニュー」ブロック（約1442〜1663行目）のみ。
  - `switchOverlay`変数を追加し、`_isMobilePage`の場合のみ生成・`document.body`に追加。
  - `switchMenu.style`の`Object.assign()`を`_isMobilePage`の三項分岐に変更。モバイル分岐は中央固定表示用のプロパティ（`left/top/transform/borderRadius/width/maxHeight/boxShadow`）に変更し、それ以外（`background/border/overflowY/zIndex/padding/fontFamily/fontSize/pointerEvents`）は無変更。デスクトップ分岐は元の実装とバイト単位で同一。
  - `openMenu()`：モバイルの場合は`switchOverlay.style.display = 'block'`を追加するのみ（位置計算は不要、CSSの中央固定表示に任せる）。デスクトップの場合は元の`switchBtn.getBoundingClientRect()`による`left`計算をそのまま維持。
  - `closeMenu()`：`switchOverlay`が存在する場合は`display = 'none'`にする一行を追加。
  - `switchOverlay`へのクリックリスナーを新設（クリック対象がオーバーレイ自身の場合のみ`closeMenu()`）。既存の「メニュー外クリックで閉じる」`document`リスナーは変更なし（モバイルでは機能的に重複するが、`closeMenu()`は冪等のため問題なし）。
  - `buildSwitchMenu()`（APIからプロジェクト一覧を取得してメニュー項目を構築する処理）は無変更。
- **`gantt-mobile.html`側の追加確認**: `proxyClick('mobileMenuSwitchBtn', 'collab-switch-btn');`（約31157行目）は既存のまま変更不要（クリックを`collab-switch-btn`へ委譲するだけで、実際の開閉処理は`collab-client.js`側の`switchBtn.onclick`に委ねられているため）。ハンバーガーメニュー本体`#mobileMenuPanel`（`z-index:100050`）は、新設した`#collab-switch-overlay`（`z-index:100000`）/`#collab-switch-menu`（`z-index:100001`）より上位のz-indexのまま開いた状態が残る（`proxyClick()`が`stopImmediatePropagation()`するため、`#mobileMenuPanel`側の「メニュー項目クリック後に自動的に閉じる」処理は実行されない）。これは既存の通知パネルを開いた場合と全く同一の挙動（Playwrightで実際に確認済み）であり、ユーザーが実施したTask #6の再調査でも「通知パネル表示位置自体は改良する必要はない」と結論済みのため、本Task #5でも同一パターンを踏襲する形で対応不要と判断した。
- **Playwright検証**: iPhone 13エミュレーションで、ハンバーガーメニュー→「プロジェクト切替」タップ後、`#collab-switch-overlay`が`display:block`・`#collab-switch-menu`が画面中心（誤差40px以内）に表示されることを確認。オーバーレイの背景クリックで両方`display:none`に戻ることを確認。デスクトップ（PC相当のビューポート、`gantt-collab.html`）では`#collab-switch-overlay`要素自体が生成されないこと、メニューの`bottom:28px`・`left`計算値（ボタンの`getBoundingClientRect().left`と一致）が旧実装と完全に同一であることを確認。メニュー内部（ヘッダー等、項目以外の箇所）をクリックしても閉じないこと（既存の「メニュー外クリックのみで閉じる」挙動維持）も確認。全ケースPASS。

### 5.3 「プロジェクト切替」「通知」タップ時の統合メニュー(#mobileMenuPanel)自動クローズ(Task #5追加要望・実装済み)

- **要望内容**: 5.2節の対応で「プロジェクト切替」メニューの表示位置自体は改良されたが、統合メニュー(ハンバーガーメニュー、`#mobileMenuPanel`、`z-index:100050`)を開いた状態のままメニュー項目「プロジェクト切替」または「通知」をタップした場合、5.2節の説明にある通り`proxyClick()`が`stopImmediatePropagation()`するため`#mobileMenuPanel`側の「メニュー項目クリック後に自動的に閉じる」処理が実行されず、`#mobileMenuPanel`がより上位のz-indexのまま背後に開いたまま残ってしまう。ユーザーから、この2項目については目的のウィンドウメニュー(プロジェクト切替の`#collab-switch-menu`／通知の`#notif-panel`)を表示する前に、事前に統合メニューを閉じるよう追加要望があった。
- **対応方針(承認済み)**: `gantt/gantt-mobile.html`の`wire()`関数内、`proxyClick('mobileMenuSwitchBtn', 'collab-switch-btn')`と`proxyClick('mobileMenuNotifBtn', 'notif-bell-btn')`の2箇所のみ、`proxyClick()`の第3引数`beforeDelegate`（実際のクリック委譲(`setTimeout`)より前に同期的に実行される処理）を渡し、その中で`document.getElementById('mobileMenuPanel').hidden = true`を実行するように変更した。`beforeDelegate`は実際のクリック委譲より前に同期的に実行されるため、「統合メニューを閉じる → 目的のウィンドウメニューを開く」の順序を保証できる。
- **修正箇所**: `gantt/gantt-mobile.html`の`wire()`関数内のみ（約31157〜31167行目）。`collab/collab-client.js`・PC版(`gantt-collab.html`)・`#settingsPopover`には一切触れていない。
- **対象外の項目**: `mobileMenuSettingsBtn`(ユーザー設定=`#settingsPopover`)、`mobileMenuAccountBtn`、`mobileMenuProjectBtn`、`mobileMenuLogoutBtn`は、クリック後にページ遷移またはポップアップ表示に切り替わるため、統合メニューが背後に残っても実害がなく、ユーザー要望通り今回の修正対象外とした（`#mobileMenuPanel`は開いたままだが、遷移先ページ表示または`#settingsPopover`表示の前面に隠れるため実際の見た目上の問題はない。Playwrightでも実際に既存動作(`#settingsPopover`が正しく開くこと)に変化がないことを確認済み）。
- **Playwright検証**: iPhone 13エミュレーションで、(1)ハンバーガーメニューを開いた状態で「プロジェクト切替」をタップ →`#mobileMenuPanel.hidden`が`true`になり、`#collab-switch-menu`が`display:block`で画面中央に表示されることを確認。(2)同様に「通知」をタップ →`#mobileMenuPanel.hidden`が`true`になり、`#notif-overlay`が`display:block`で通知パネルが表示されることを確認。(3)ページをリロードし、ハンバーガーメニューを開いた状態で「ユーザー設定」をタップ →`#settingsPopover.hidden`が`false`（正しく開く）ことを確認し、この項目については既存動作に変化がないことも確認。3ケースともJSエラーなくPASS。
- この方式はユーザー確認済み（2026-08-13、設計方針を提示し承認を受けて実装）。

### 5.4 ハンバーガーメニューへの「接続者(*人)」項目追加(新規要望・実装済み)

- **要望内容**: PC版はステータスバー右端に接続者を色付き■（`#collab-presence`、カーソルを乗せるとtitle属性で氏名がツールチップ表示される）で表示しているが、モバイル版には対応する表示がない。ユーザーからハンバーガーメニュー（`#mobileMenuPanel`）の「通知」の直下に「接続者(*人)」（*は自分を含む接続人数、接続状況により動的に変化）という項目を追加し、タップすると「プロジェクト切替」メニューと同様の見た目のウィンドウメニューが開き、接続中の全メンバーを縦一列で「■（本人のプレゼンスカラー）＋表示名」の形式で（PC版のようなホバー依存ではなく）常時全員分表示する、という要望があった。ユーザー提示のモックアップ:
  ```
  （ハンバーガーメニュー）              （接続者ウィンドウメニュー）
  ユーザー設定                          接続者(*人)
  アカウント管理                        ■竹田
  プロジェクト管理                      ■テスター
  プロジェクト切替                      ■竹山
  通知
  接続者(*人)
  ログアウト
  ```
- **対応方針(4点・承認済み)**: 5.2節の「プロジェクト切替」メニュー（オーバーレイ＋画面中央固定表示のウィンドウメニュー）と全く同じ見た目・構造で実装する4点構成を提示し、ユーザーから「確認しました．1～4について，あなたの提案する内容でOKです．進めてください．」と承認を得た（2026-08-13）。
  1. `gantt-mobile.html`の`#mobileMenuPanel`に、`#mobileMenuNotifBtn`（通知）と`#mobileMenuLogoutBtn`（ログアウト）の間に`#mobileMenuPresenceBtn`ボタンを新設する。
  2. PC版のステータスバー上には「接続者」に対応するクリック可能なボタンが存在しない（■表示のみ）ため、`collab-client.js`側に非表示の委譲先ボタン`#collab-presence-btn`を新設し、`wire()`関数内で`proxyClick('mobileMenuPresenceBtn', 'collab-presence-btn', beforeDelegate)`により委譲する（`beforeDelegate`で5.3節と同様に`#mobileMenuPanel`を先に閉じる）。
  3. `collab-client.js`の`renderPresence(users)`（`presence_update`イベント受信の都度呼ばれる、既存のPC版描画ロジックはそのまま維持）に、モバイル向けの追加処理を`_isMobilePageTop`（IIFEトップレベル変数、`init()`内で判定される`_isMobilePage`をコピーしたもの）でガードして追記する。具体的には`#mobileMenuPresenceBtn`のラベルを`接続者(${人数}人)`に更新し、ウィンドウメニューが開いている最中であれば内容も再構築する。
  4. ウィンドウメニュー本体`#collab-presence-menu`＋オーバーレイ`#collab-presence-overlay`は、5.2節の`#collab-switch-menu`/`#collab-switch-overlay`と全く同じスタイル（`position:fixed; left/top:50%; transform:translate(-50%,-50%)`＋暗転オーバーレイ、オーバーレイクリック/外側クリックで閉じる）で新設し、`_isMobilePage`の場合のみ生成する（PC版では要素自体が生成されない）。メニュー内の各行はPC版の■のように`title`属性でホバーさせるのではなく、色付き■（`u.color`）＋表示名（`u.displayName || u.userId`）を1行に並べて表示し、全員分を常時表示する。
- **修正箇所**:
  - `gantt/gantt-mobile.html`: (a) `#mobileMenuPanel`のHTMLに`<button id="mobileMenuPresenceBtn" type="button" class="mobile-menu-item">接続者</button>`を追加（約5822行目、`#mobileMenuNotifBtn`と`#mobileMenuLogoutBtn`の間）。(b) `wire()`関数内、`mobileMenuNotifBtn`用`proxyClick()`呼び出しの直後に`proxyClick('mobileMenuPresenceBtn', 'collab-presence-btn', function(){ ... #mobileMenuPanelを閉じる ... })`を追加（約31169行目）。
  - `collab/collab-client.js`: (a) `UI`モジュールのIIFEトップレベルに`_isMobilePageTop`（既定`false`）/`_presenceUsers`（既定`[]`）/`_refreshPresenceMenuIfOpen`（既定`null`）を新設。(b) `init()`内、既存の`const _isMobilePage = Boolean(window.__GANTT_MOBILE__);`の直後に`_isMobilePageTop = _isMobilePage;`を追加（既存のローカル変数`_isMobilePage`自体のその後の使われ方は無変更）。(c) 5.2節の「プロジェクト切替」ドロップアップ生成ブロック（`document.body.appendChild(switchMenu);`）の直後に、`if (_isMobilePage) { ... }`でガードした新規ブロック（約150行）を追加し、`#collab-presence-btn`（非表示の委譲先`<a>`）／`#collab-presence-overlay`／`#collab-presence-menu`（`#collab-presence-menu-header`を含む）を生成し、`renderPresenceMenuItems()`/`openPresenceMenu()`/`closePresenceMenu()`とオーバーレイ・外側クリックの各リスナーを定義する。`renderPresenceMenuItems`は`_refreshPresenceMenuIfOpen`に登録し、他関数（`renderPresence()`）から呼び出せるようにする。(d) `renderPresence(users)`の先頭に`_presenceUsers = users || [];`と、`_isMobilePageTop`でガードした`#mobileMenuPresenceBtn`ラベル更新・メニュー再構築処理を追加。それ以降の既存PC版描画ロジック（`presenceEl`への■生成、人数ラベル`countLabel`）は一切変更していない。
- **PC版への影響**: `_isMobilePage`（`window.__GANTT_MOBILE__`未設定時は`false`）でガードされているため、`gantt-collab.html`では`#collab-presence-btn`/`#collab-presence-menu`/`#collab-presence-overlay`のいずれも生成されず、既存の`#collab-presence`（■＋ホバーtitle表示）の動作・見た目は完全に無変更。
- **Playwright検証**: 実サーバー（Socket.IOバックエンド）が存在しないため、`page.addInitScript()`で`window.io`を「`.on(event, handler)`で登録されたハンドラを`window.__capturedHandlers`に捕捉するフェイクsocket」に差し替え、`collab-client.js`の`loadSocketIO()`内`if (window.io) { resolve(window.io); return; }`分岐によりCDN読み込みの代わりにこのスタブが使われるようにした上で、捕捉した`presence_update`ハンドラをテストから直接呼び出す方式で検証した。iPhone 13エミュレーションで以下を確認、全ケースPASS（JSエラーなし）:
  - 3人分の`presence_update`（竹田/テスター/竹山、モックアップと同じ表示名）受信後、`#mobileMenuPresenceBtn`のテキストが`接続者(3人)`に更新されること。
  - ハンバーガーメニューを開いた状態で「接続者(3人)」をタップ→`#mobileMenuPanel.hidden`が`true`になり、`#collab-presence-menu`/`#collab-presence-overlay`が`display:block`で画面中央に表示され、ヘッダーが`接続者(3人)`になること。
  - メニュー内に3行、それぞれ指定した色（`background-color`が期待値と一致）＋氏名（`竹田`/`テスター`/`竹山`）がホバー等の追加操作なしに常時表示されていること。
  - 2人分の`presence_update`（竹田/テスターのみ）を再受信すると、開いたままのメニューの人数ラベル・行内容が`接続者(2人)`＋2行に動的に更新されること（人数変動への追随を確認）。
  - オーバーレイの背景部分をクリックするとメニューが閉じる（`display:none`に戻る）こと。
  - PC版（`gantt-collab.html`、モバイルフラグなし）で同じ`presence_update`を受信させても、`#collab-presence-btn`/`#collab-presence-menu`/`#collab-presence-overlay`のいずれも生成されず、既存の`#collab-presence`（■が複数生成される）表示は変化しないこと。
  - スクリーンショットで、ハンバーガーメニューの項目順（ユーザー設定/アカウント管理/プロジェクト管理/プロジェクト切替/通知/接続者(3人)/ログアウト）およびウィンドウメニューの見た目（ヘッダー「接続者(3人)」＋■＋氏名を縦一列表示）がユーザー提示のモックアップと一致することを目視確認済み。
- この方式はユーザー確認済み（2026-08-13、4点の設計方針を提示し「確認しました．1～4について，あなたの提案する内容でOKです．進めてください．」と承認を受けて実装）。

---

## 6. 実装時の注意点（開発ルール遵守）

- `gantt-collab.html` のコアロジック（右ペイン描画・矢印描画等）を変更した場合、`gantt-mobile.html` にも同様の修正を反映する必要がある（両ファイルは移植元・移植先の関係にあるため、コアロジック部分は今後も同期を意識する）。
- `#settingsPopover` には追加・変更を行わない。
- 状態変更を伴う関数の `render()` 呼び出し後には `COLLAB-HOOK`（`gantt:op` カスタムイベント）を発火させる実装を、移植したロジックについても引き続き遵守する。
- 本機能に関する全てのコミットメッセージは以下の形式に従う:
  ```
  【修正ファイル】XXX
  【修正内容】XXX
  ```

---

## 7. 未確定事項・今後の検討事項

- 【確定・実装済み(Task #4)】デバイス判定の具体的な実装方法は「UA判定＋タッチ判定の併用、メディアクエリ/ウィンドウ幅は不使用」に確定し、`login.html`の`redirectToGantt()`に実装した。詳細は5節参照。
- 【確定・実装済み(Task #4追加分)】`projects.html`/`account.html`の「ガントチャートへ戻る」リンクが`gantt-collab.html`に固定されており、モバイル/タブレット端末でこれらのページに遷移した場合にPC版へ戻ってしまう不整合がユーザー自身の調査で判明していた問題(2026-08-11)は、共有ファイル`collab/device-detect.js`を両ファイルから読み込む形で解消済み。詳細は5.1節参照。
- タスク長押し時の簡易操作シートに含める項目の精査（切り取り/コピー/貼り付け/今日に移動/1階層下に追加、のうちどれをどう優先表示するか）は実装時に詳細UIを提示し再確認する。
- 【右ペイン日付エリアのスワイプ操作は実装不要と判断・確定】通常表示状態で右ペインの何もないマス目をドラッグすれば左右に移動できる（既存の`beginCreate()`起点のポインタドラッグによるスクロール挙動）ため、当初検討していたスワイプ専用の移動操作は追加実装しないこととした（ユーザー確認済み、2026-08-11）。
- 【ダブルタップで「今日」付近へ移動する機能・実装済み】上記の判断に伴い、初期スコープ外としていた本機能を前倒しで実装した（`gantt-mobile.html`のみ、`gantt-collab.html`は無変更でPC版は引き続き今日ボタンを使用）。
  - `#todayBtn`（今日ボタン）は完全に削除し、`ui.timelineHeader`（タイムライン上部の月/日付/曜日を表示しているヘッダー部分、`.timeline-header`要素）に新設した`dblclick`ハンドラ`handleTimelineHeaderDoubleClick`に置き換えた。
  - 対象領域は「タイムライン上部の日付ヘッダー」であり、下部のExcel風グリッド（`ui.timelineScroller`、タスクバー・依存線を配置する領域）は対象外。ヘッダー部分は元々左右ドラッグでのスクロール操作（`handleTimelineHeaderPointerDown`等）のみを持ち、タスクバーや依存線のような個別のdblclickハンドラを持つ要素が存在しないため、除外処理は不要でシンプルな実装になっている。
  - ダブルタップすると既存の`scrollTodayIntoView(true)`をそのまま呼び出す。「今日」が表示範囲外の場合は既存通りトースト「表示範囲に「今日」はありませんでした。」が表示される。
  - ヘッダーの`pointerdown`ハンドラ（`handleTimelineHeaderPointerDown`）は左右ドラッグスクロール用に`event.preventDefault()`を呼んでいるが、既存の`#paneResizer`（左右ペイン境界、同様に`pointerdown`で`preventDefault()`しつつ`dblclick`も正常に動作する実装）と同じ構造のため、`dblclick`イベントの発火が阻害されないことを確認済み。
  - `#prevBtn`/`#nextBtn`（前へ/次へボタン、および`#prevDayBtn`/`#nextDayBtn`）は今回のスコープ外として変更していない。
  - 【途中経緯】初回実装時はユーザー指示の「右ペインの日付エリア」を下部のタイムライングリッド（空白部分）と解釈し、`ui.timelineScroller`に対して`.task-bar`/依存線を除外する`handleTimelineDoubleClick`を実装したが、後日ユーザーより「日付エリアとは上部の日付・曜日・年が表示されている部分（ヘッダー）を指していた」との訂正があり、対象要素を`ui.timelineHeader`に変更し、除外処理も不要な形に修正した。
  - この方式はユーザー確認済み（2026-08-11、設計提案を提示し「提案の内容で進めてください」と承認、その後「右ペインの日付エリア」の解釈違いについて訂正・再承認）。
- `collab-client.js` の `#collab-status-bar` をモバイルでどう扱うか（そのまま使う/レイアウトだけ調整/機能を統合メニューに完全移管する）は実装の中で調整しながら進める。
- 【確定・実装済み(Task #5)】「プロジェクト切替」ドロップアップ（`#collab-switch-menu`）が、モバイル版で画面左下に表示されてしまう不具合を、通知パネルと同じ「オーバーレイ＋画面中央固定表示」（A案）に統一して解消した。詳細は5.2節参照。なお、通知パネル自体の表示位置はユーザーの再調査により問題なしと確認済み（Task #6・対応不要でクローズ）。
- 【確定・実装済み(Task #5追加要望)】「プロジェクト切替」「通知」タップ時に統合メニュー(`#mobileMenuPanel`)が背後に開いたまま残る点について、`gantt/gantt-mobile.html`の`wire()`関数内の該当2箇所のみ、`proxyClick()`の`beforeDelegate`経由で事前にパネルを閉じるように対応した。詳細は5.3節参照。
- 【確定・実装済み(新規要望)】PC版ステータスバーの接続者■表示（ホバーで氏名表示）に対応する項目がモバイル版に無かった点について、ハンバーガーメニューに動的な人数表示付き「接続者(*人)」項目を追加し、タップすると「プロジェクト切替」と同様のウィンドウメニューで全接続者（■＋氏名、ホバー不要）を一覧表示するようにした。詳細は5.4節参照。
- 【依存線作成（右ドラッグの代替）の実装方式・確定】タッチデバイスに右クリック/右ドラッグは存在しないため、タスクバーの**長押し**を起点に、PC版の「右ボタン押下→分岐」と同じ構造を再現する方式で実装した（`gantt-mobile.html`のみに追加、`gantt-collab.html`は無変更）。
  - タスクバーを約450ms押し続けると（`MOBILE_LONG_PRESS_MS`）、PC版の`beginDependencyDraft()`を直接呼び出し、右ボタン押下時と同じ内部状態（`interaction.mode = 'link-pending'`）に入る。長押し確定時は`navigator.vibrate()`が使える端末では軽いバイブレーションでフィードバックする。
  - 長押しがそのまま確定し、指を動かさずに離すと、ブラウザが合成する`contextmenu`イベント経由で既存の`#contextMenu`（階層操作メニュー）が表示される（コード変更なしで動作する仕組みを流用）。
  - 長押し確定後に指をスライドさせると、既存の`updateDependencyDraft()`/`renderDependencies()`がそのまま処理し、依存線のライブプレビューが指に追従。有効な対象タスク上で離すと既存の`createDependency()`が呼ばれて依存線が確定する。
  - 長押し確定前（`MOBILE_LONG_PRESS_MOVE_TOLERANCE`=10px以上）に大きく動いた場合は、タスクの移動/リサイズ操作と判断し、長押しタイマーをキャンセルする（通常の移動/リサイズ動作を維持）。
  - アンカー固定タスク（移動/リサイズ不可）についても、PC版の右クリックと同様に依存線作成の起点にできるよう、長押しタイマーのみ仕掛けている。
  - モバイル専用のツールチップ文言として「接続先タスクへ右ドラッグ」を「接続先タスクまでスライド」に変更（`gantt-mobile.html`側のみ）。
  - この方式はユーザー確認済み（2026-08-10、設計提案を提示し「その提案内容で進めてOK」と承認）。
  - 【実装後の追加修正】実機テストで、長押しが確定して指を離す前(まだ保持中)にモバイルブラウザが独自に`contextmenu`イベントを合成して発火することが判明した(PC版はマウスの「離した後」に発火する前提のため想定外だった)。このため「そのまま離す→メニュー」の判定がユーザーの指がまだ画面上にある時点で誤発動し、以降のスライドで依存線の破線プレビューが出ない不具合が発生した。対策として、`interaction.mode`が`'link-pending'`/`'link-dragging'`の間はブラウザ標準の`contextmenu`イベントを常に無視するように変更し、代わりに「長押し確定→動かさず指を離した」判定を`pointerup`(`handlePointerUp`)側で明示的に行い、そこから自前で`showContextMenu()`/`showMultiTaskContextMenu()`を呼び出すように変更した。
  - 【実装後の追加修正2】上記修正の直後の実機テストで、今度は「長押し確定→動かさず指を離す」という正しい操作をしても階層メニューが一切表示されなくなる回帰不具合が発生した。原因は、長押しタイマーの発火コールバック内で`mobileLongPress.fired = true`を`clearInteraction()`より**前**に設定していたため、`clearInteraction()`が内部で呼び出す`clearMobileLongPressTimer()`によって直後に`fired`が`false`へリセットされてしまい、`pointerup`側で「長押しが確定していたか」を正しく判定できなくなっていたことによる。`clearInteraction()`実行後に`fired`等を再設定する順序に修正して解消した。
  - 【依存線(矢印)の長押しメニューにも同種の不具合を確認・修正】既存の依存線を長押しした際にも、タスクバーと同じ理由(モバイルブラウザが指を離す前に`contextmenu`を合成発火する)で、`handleDependencyContextMenu`の「色を変更」「線種を変更」「削除」等のメニューが指を離す前に表示されてしまう不具合が見つかった。依存線のクリック/右クリック処理はタスクバーと異なり共有の`interaction`状態機械を使わず、`state.selectedDependencyId`という独立した選択状態のみを持つ単純な作りのため、依存線専用の軽量な長押しタイマー（`mobileDepLongPress`、450ms判定・10px移動許容、`gantt-mobile.html`のみに追加）を新設して対応した。長押し中はネイティブ`contextmenu`を無視し、`pointerup`側で「長押し確定・かつ動かさず離した」場合にのみ、`handleDependencyContextMenu`と同じ選択更新＋`showDependencyContextMenu()`呼び出しを自前で行う。依存線には作成操作のようなスライド分岐先が無いため、タスクバー版よりも単純な仕組みで完結している。あわせて、依存線の当たり判定要素（`.dependency-hit`）にもタスクバーと同様`touch-action: none`を付与し、長押し中にブラウザ標準のスクロールジェスチャーが割り込むリスクを予防した。この方式はユーザー確認済み（2026-08-11、設計提案を提示し「提案の方式で進めてください」と承認）。
  - 【実装後の追加修正】上記実装後の実機テストで、依存線の長押しに反応しないことがあり、詳しく見るとタスクバーのタスク名ラベルの文字列がテキスト選択状態（選択ハンドル表示）になってしまう不具合が見つかった。原因は、実績機能ON時にタスク名を最前面表示するため`.task-bar`の子要素ではなく兄弟要素として独立配置される`.bar-label-float`に`user-select: none`が指定されておらず、`.task-bar { user-select: none; }`のCSS継承も効かない状態だったこと。依存線の当たり判定は細い線のため、長押しの指位置が少しズレるとこの無防備なラベル要素に長押しが伝わり、ブラウザ標準のテキスト選択が誤発動していた。`.bar-label-float`に`user-select: none`（`-webkit-user-select`/`-webkit-touch-callout`含む）を追加して解消した。
- 【右ペイングリッド(`.timeline-scroller`)の縦スクロール不能バグを修正】タスク数が増えて右ペインのグリッド(タスクバー・依存線を配置するExcel風のグリッド領域)の内容が画面の縦幅を超えても、モバイル実機では空白グリッド領域を指でなぞってもスクロールできず、一覧最下部の「＋ タスク追加」ボタン等に到達できない不具合が実機テストで見つかった(PC版はマウスホイール/スクロールバーで問題なくスクロール可能)。
  - 原因: `.timeline-scroller`(右ペインのスクロールコンテナ)に`touch-action`指定が無く(デフォルトの`auto`)、空白グリッド領域への`pointerdown`は`handleTimelinePointerDown()`経由で常に`beginCreate()`(新規タスク作成のドラッグ待機、`interaction.mode = 'create-pending'`)を開始する実装になっているため、ブラウザ側のタッチスクロールジェスチャー認識とJS側のカスタムポインター処理(Pointer Events)が競合し、縦方向のネイティブスクロールジェスチャーが機能しなくなっていた。
  - 対策: `.timeline-scroller`に`touch-action: pan-y`を追加し、縦方向のネイティブスクロールジェスチャーをブラウザに優先させるようにした(`gantt-mobile.html`のみ、CSSのみの変更で対応。`gantt-collab.html`は無変更)。既存の`.task-bar`/`.bar-handle`/`.dependency-hit`に付与済みの`touch-action: none`(タスクバー上・依存線上ではJS側の処理に完全に委ねる)とは競合しない(子要素側の指定が優先されるため、タスクバー・依存線上の操作は従来通り)。
  - 新規タスク作成ドラッグ(`beginCreate()`→`create`モード)は横方向(日付軸)の移動のみをプレビュー範囲の計算に使用しており(縦方向はpointerdown時点の対象行のホバー判定に一度使うのみで、ドラッグ中の縦方向移動は追跡していない)、`pan-y`指定後もこの横方向のドラッグ操作(createモードへの遷移や端でのオートスクロール)はブラウザに奪われずJS側のPointer Events処理に届き続けるため、既存のタスク作成機能への影響はない。
  - この方式はユーザー確認済み(2026-08-11、モバイル/PC比較のスクリーンショット付きで不具合報告を受け、設計提案を提示し「提案の内容で進めてください」と承認)。
  - 【実装後の追加修正(fix#2)】上記`touch-action: pan-y`を適用した実機テストで、縦方向のスクロールは可能になったものの、一覧最下部の「＋ タスク追加」ボタンおよびその直前のタスク行までは到達できず、タスク数が増えるほどスクロール不能な領域が拡大する回帰的な不具合が判明した(ユーザー報告：「1.×　縦に表示を移動させることができるようになったことは確認しました．しかしながら，最下段「＋ タスク追加」ボタンまでスクロールできていません．タスクを増やすと隠れてしまう領域も増え「+タスク追加」の上のタスク+αもスクロールで表示されないようになるようです．」)。横方向ドラッグでの新規タスク作成(2.〇)、タスクバーの移動/リサイズ/長押し依存線作成(3.〇)には回帰がないことも合わせて確認された。
    - 再診断: 本アプリはタイムライングリッドに仮想スクロール(`renderRowsVirtual()`/`renderBarsVirtual()`を`.timeline-scroller`の`scroll`イベントごとに`requestAnimationFrame`でDOM再構築する方式)を採用している。モバイルブラウザのネイティブなモーメンタム(慣性)スクロールは、ジェスチャー進行中にDOMが書き換わると距離計算を誤り、スクロールが途中で停止してしまうことがあるという既知の類の不具合があり、これがタスク数(=1スクロールフレームあたりのDOM書き換え量)の増加に比例して悪化するという症状と一致する。JSで`scroller.scrollTop`を強制的に最大値へ設定すると全タスク+追加ボタンが問題なく表示されることも別途確認しており(`scrollHeight`計算自体は正しい)、問題はスクロール量計算ではなくスクロール「ジェスチャー」側にあると判断した。
    - 対策: `touch-action: pan-y`を`touch-action: none`に戻してブラウザ標準のタッチスクロールへの依存を完全に廃止し、代わりに縦スクロールもJS側(Pointer Events)で直接`scrollTop`を制御する自前実装に切り替えた。既存の横方向ドラッグ(タイムラインヘッダーの`timelineHeaderDragState`パターン)を踏襲しつつ、空白グリッド領域の`create-pending`(新規タスク作成ドラッグ待機)中に`DRAG_THRESHOLD`(6px)を超えた時点で移動量の縦横比較(`Math.abs(deltaX)` vs `Math.abs(deltaY)`)を行い、横方向優位なら従来通り`'create'`モードへ、縦方向優位なら新設の`'scroll-drag'`モードへ分岐するようにした。`'scroll-drag'`モードでは`beginCreate()`時に記録した`interaction.startScrollTop`を起点に、ポインター移動量(`deltaY`)を差し引いた値を`clamp()`で有効範囲に収めて`ui.timelineScroller.scrollTop`へ直接反映し、`syncHeaders()`を呼んで左ペイン・依存線レイヤーとの同期を保つ。`scroll-drag`モードで指を離してもタスクは作成されず、`clearInteraction()`のみ行う(`gantt-mobile.html`のみの変更。`gantt-collab.html`は無変更)。
    - 検証: Playwright(iPhone 13エミュレーション、Pointer Events合成によるドラッグ再現)にて、タスク15件の状態で1回の下方向ドラッグのみで`scrollTop`が最大値(スクロール可能領域の下端)まで到達し、「＋ タスク追加」ボタンが完全に可視領域内に入ることを確認した。縦ドラッグ中にタスクが誤って作成されないこと(タスク数不変)、および横方向ドラッグでは従来通り新規タスクが作成されること(タスク数+1)も合わせて確認済み。
    - この方式はユーザー確認済み(2026-08-11、fix#1の実機テスト結果(縦スクロール可能領域が最下部まで届かない不具合)を受けて再診断・設計を提示し「その方針で進めてください」と承認)。
  - 【実装後の追加修正(fix#3)】fix#2適用後の実機テストで「最下部の「＋タスク追加」ボタンまでスクロールできない」との再度の回帰報告を受けた(ユーザー報告：「モバイル用での最下部の「＋タスク追加」ボタンまでスクロールできません。」)。詳細な再現手順(スクリーンショット付き)を確認した結果、ユーザーが実際に指を置いてスワイプしていたのは.timeline-scroller(右ペイン、タイムライングリッド)ではなく左ペイン(.left-body、タスク名一覧)の空白領域であり、実際のレイアウトでは左ペインが画面幅の大半を占めていたことが判明した。fix#2は.timeline-scrollerのみにJS駆動スクロールを実装していたため、左ペインでのスワイプには何も対応しておらず、素通しでブラウザ標準のページジェスチャーとして扱われていた。
    - 再診断: 左ペイン(.left-body)にtouch-action指定が無いため、空白領域への縦スワイプがブラウザ標準のページ/ビューポートジェスチャー(モバイルブラウザのアドレスバー開閉等)として処理される。`.app-shell`が`height: 100vh`を使用しており、これはアドレスバーの表示/非表示に応じて実際の値が変動する既知の問題があるため、ジェスチャー中にレイアウトが再計算されて`.timeline-scroller`の`clientHeight`/`scrollHeight`ベースのスクロール可能量計算が乱れると判断した。ユーザーが追加で報告した「左ペイン下部でピンチアウトすると一時的に「＋タスク追加」が表示される」という現象も、ピンチズームが強制的にレイアウト再計算を発生させることと整合する。
    - 対策: (1) `.left-body`に`touch-action: pan-x`を指定し、縦方向のネイティブジェスチャーを無効化(横スクロールは維持)。(2) 右ペインの`scroll-drag`モードと同じ考え方で、左ペイン専用の軽量な状態オブジェクト`leftScrollDrag`と`handleLeftBodyPointerDown`/`handleLeftBodyPointerMove`/`handleLeftBodyPointerUp`を新設し、`ui.leftBody`への`pointerdown`/`pointermove`/`pointerup`/`pointercancel`で登録。フォーム要素・インライン編集中テキストボックス・行ドラッグハンドル(`.row-drag-handle`)は対象外とし、`event.pointerType === 'mouse'`の場合は何もしないことで既存のマウスドラッグによる行並び替え(`onHandleMouseDown`/`_rowDragState`、`mousedown`ベース)と完全に独立させた。`DRAG_THRESHOLD`(6px)を超えた時点でドラッグ確定し、`ui.timelineScroller.scrollTop`を直接`clamp()`で更新して`syncHeaders()`を呼ぶ(`.left-body.scrollTop`は`syncHeaders()`内の既存の一方向同期で追従)。(3) `.app-shell`の高さを`height: 100vh; height: 100dvh;`という順で指定し(対応ブラウザは`100dvh`が優先され、非対応ブラウザは`100vh`のままフォールバック)、アドレスバー変動によるレイアウト不安定要因を低減した。
    - 検証: Playwright(iPhone 13エミュレーション、デフォルトの折り畳みモードのまま=左ペインが画面幅の大半を占める、実際のユーザー環境に近いレイアウトで再現)にて、タスク15件の状態で左ペインの空白領域を縦方向にPointer Eventsでドラッグし、`scrollTop`が最大値まで到達し「＋ タスク追加」ボタンが完全に可視領域内に入ることを確認した。ドラッグ中にタスクが誤作成されないこと・行順序が変化しないこと(タスク数・行順不変)も確認済み。また、マウスの`mousedown`/`mousemove`/`mouseup`を用いた既存の行ドラッグ&ドロップ機能(タスクの並び替え)が今回の変更後も正常に動作すること(実際に並び替えが発生すること)を別途確認した。右ペインでの横方向ドラッグによる新規タスク作成の回帰も無いことを確認済み。`node --check`による全10スクリプトブロックの構文検証もOK。(`gantt-mobile.html`のみの変更。`gantt-collab.html`は無変更)
    - この方式はユーザー確認済み(2026-08-11、fix#2適用後の実機テストで左ペインのスワイプが原因であることをユーザー自身が詳細な再現手順・スクリーンショットで特定し、その情報を基にした再診断・設計提案に対して「その方針で進めてください」と承認)。
