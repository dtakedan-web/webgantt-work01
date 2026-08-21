-- ============================================================
-- WebGantt: 社内グループウェア（intra-mart）スケジュール連携（ブラウザ拡張機能方式）
-- マイグレーション: groupware_schedule_extension_tokens テーブル作成
-- ============================================================
-- 参照: docs/groupware-schedule-import-design.md 10.1節・11.1節
-- 実行方法（本番サーバー）:
--   mysql -u root -p gantt_collab < docs/sql/2026-08-21_groupware_schedule_extension_tokens.sql
-- （DDL権限が必要なためroot等の管理ユーザーで実行。作成後の通常アクセスは
--   既存の.env設定のWEBGANTT_DB_USER（例: gantt_app）が使用する）
--
-- 注意: user_id は既存 users.id（bigint、符号あり）と型を完全一致させる
-- 必要がある（MySQL 8.0のFOREIGN KEY制約は型不一致だとERROR 3780になる）。
-- teams_excel_extension_tokens（2026-08-18）と同一の命名・型規約を踏襲している。
--
-- 設計書11.1節（コード分離方針）: 本機能はサーバー側で「特殊（汎用性は低い）」
-- 機能として明示的に分離することが確定要望のため、テーブル名は
-- groupware_schedule_ プレフィックスで統一し、将来この機能を廃止する場合は
-- 「api/groupware_schedule_import.php の削除」「本テーブル群のDROP TABLE」
-- 「account.html内の該当セクション削除」の3ステップで完全撤去できるようにする。
--
-- 本テーブルの役割: 拡張機能専用のBearerトークン（Cookieセッションとは別体系）を
-- 1ユーザーにつき1件のみ保持する。既存の sessions テーブルには一切影響しない。
-- トークンprefixは teams_excel_extension_tokens の tex_ と区別するため gws_ とする
-- （GroupWare Scheduleの意。api/groupware_schedule_import.php参照）。
--
-- ロールバック（機能を撤去する場合）:
--   DROP TABLE IF EXISTS groupware_schedule_extension_tokens;
-- ============================================================

CREATE TABLE IF NOT EXISTS groupware_schedule_extension_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,                  -- users.id (bigint, 符号あり) と完全一致させる
  token_hash CHAR(64) NOT NULL,             -- トークン文字列のSHA-256ハッシュ（生トークンはDBに保存しない。発行時に1回のみ画面表示）
  last_used_at DATETIME NULL,               -- 直近の拡張機能API利用日時（デバッグ・不正利用検知の参考表示用）
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_id (user_id),           -- 1ユーザー1トークンのみ（再発行時は既存行をUPDATEし旧トークンを自動失効）
  UNIQUE KEY uq_token_hash (token_hash),
  CONSTRAINT fk_gset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
