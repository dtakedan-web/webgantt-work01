-- ============================================================
-- WebGantt: Outlookカレンダー（ICS連携）予定インポート機能
-- マイグレーション: office_calendar_tokens テーブル作成
-- ============================================================
-- 参照: docs/office-calendar-import-design.md 4.1節
-- 実行方法（本番サーバー）:
--   mysql -u root -p gantt_collab < docs/sql/2026-08-17_office_calendar_tokens.sql
-- （DDL権限が必要なためroot等の管理ユーザーで実行。作成後の通常アクセスは
--   既存の.env設定のWEBGANTT_DB_USER（例: gantt_app）が使用する）
--
-- 注意: user_id は既存 users.id（bigint、符号あり）と型を完全一致させる
-- 必要がある（MySQL 8.0のFOREIGN KEY制約は型不一致だとERROR 3780になる）。
-- google_calendar_tokens（2026-08-15）と同一の命名・型規約を踏襲している。
--
-- 本テーブルはAzure AD OAuth方式（当初計画・断念）ではなく、ICS購読URL方式
-- （採用・確定）を前提とした構成である。access_token/refresh_token等は
-- 保持せず、代わりに ics_url（暗号化済み）と display_label を保持する。
--
-- ロールバック（機能を撤去する場合）:
--   DROP TABLE IF EXISTS office_calendar_tokens;
-- ============================================================

CREATE TABLE IF NOT EXISTS office_calendar_tokens (
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
