-- ============================================================
-- WebGantt: Googleカレンダー予定インポート機能
-- マイグレーション: google_calendar_tokens テーブル作成
-- ============================================================
-- 参照: docs/google-calendar-import-design.md 5.1節
-- 実行方法（本番サーバー）:
--   mysql -u root -p gantt_collab < docs/sql/2026-08-15_google_calendar_tokens.sql
-- （DDL権限が必要なためroot等の管理ユーザーで実行。作成後の通常アクセスは
--   既存の.env設定のWEBGANTT_DB_USER（例: gantt_app）が使用する）
--
-- 注意: user_id は既存 users.id（bigint、符号あり）と型を完全一致させる
-- 必要がある（MySQL 8.0のFOREIGN KEY制約は型不一致だとERROR 3780になる）。
-- 2026-08-16: 本番のusers.idがbigint(符号あり)であることが判明したため、
-- 当初のINT UNSIGNEDから修正した。
--
-- ロールバック（機能を撤去する場合）:
--   DROP TABLE IF EXISTS google_calendar_tokens;
-- ============================================================

CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,                  -- users.id (bigint, 符号あり) と完全一致させる
  google_email VARCHAR(255) NULL,           -- 連携先Googleアカウントのメールアドレス（表示用）
  access_token TEXT NOT NULL,               -- openssl_encryptで暗号化して保存
  refresh_token TEXT NOT NULL,              -- openssl_encryptで暗号化して保存
  token_expires_at DATETIME NOT NULL,       -- access_tokenの有効期限
  scope VARCHAR(255) NOT NULL DEFAULT 'https://www.googleapis.com/auth/calendar.readonly',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_id (user_id),
  CONSTRAINT fk_gct_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
