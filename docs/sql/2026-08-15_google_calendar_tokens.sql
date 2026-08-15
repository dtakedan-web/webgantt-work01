-- ============================================================
-- WebGantt: Googleカレンダー予定インポート機能
-- マイグレーション: google_calendar_tokens テーブル作成
-- ============================================================
-- 参照: docs/google-calendar-import-design.md 5.1節
-- 実行方法（本番サーバー）:
--   mysql -u <db_user> -p <db_name> < docs/sql/2026-08-15_google_calendar_tokens.sql
--
-- ロールバック（機能を撤去する場合）:
--   DROP TABLE IF EXISTS google_calendar_tokens;
-- ============================================================

CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
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
