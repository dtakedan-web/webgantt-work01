<?php
/**
 * ガントチャート協調編集 API 設定 (Phase 2-A)
 * =====================================================
 * Phase 2-A 変更点:
 *   - 認証関連関数を追加（セッション管理・ログイン検証）
 *   - getCurrntUser() / requireAuth() を追加
 */

// ─── DB接続設定（Phase A: 環境変数優先・フォールバックあり） ─────
// .env / systemd Environment= / Apache SetEnv などで上書き可能。
// 参照順: WEBGANTT_DB_* → DB_*（Node WS 側の既存変数と共有可） → デフォルト値
define('DB_HOST',    getenv('WEBGANTT_DB_HOST')    ?: (getenv('DB_HOST')    ?: '127.0.0.1'));
define('DB_PORT',    (int)(getenv('WEBGANTT_DB_PORT') ?: (getenv('DB_PORT') ?: 3306)));
define('DB_NAME',    getenv('WEBGANTT_DB_NAME')    ?: (getenv('DB_NAME')    ?: 'gantt_collab'));
define('DB_USER',    getenv('WEBGANTT_DB_USER')    ?: (getenv('DB_USER')    ?: 'gantt_app'));
define('DB_PASS',    getenv('WEBGANTT_DB_PASS')    ?: (getenv('DB_PASS')    ?: 'gantt_pass'));
define('DB_CHARSET', getenv('WEBGANTT_DB_CHARSET') ?: (getenv('DB_CHARSET') ?: 'utf8mb4'));

// ─── 認証設定（Phase A: 環境変数優先） ─────────────────
define('SESSION_LIFETIME',        (int)(getenv('WEBGANTT_SESSION_LIFETIME') ?: 86400 * 7));
define('SESSION_COOKIE',          getenv('WEBGANTT_SESSION_COOKIE')         ?: 'gantt_session');
define('SESSION_PREFIX',          getenv('WEBGANTT_SESSION_PREFIX')         ?: 'gts_');
// HTTP 検証中は false、HTTPS 本番では必ず true に切替（Phase B の下地）
define('SESSION_COOKIE_SECURE',   filter_var(getenv('WEBGANTT_SESSION_COOKIE_SECURE') ?: 'false', FILTER_VALIDATE_BOOLEAN));
define('SESSION_COOKIE_SAMESITE', getenv('WEBGANTT_SESSION_COOKIE_SAMESITE') ?: 'Lax');

// ─── メール送信設定(Phase 5-9: Brevo 外部サービス連携) ──
define('MAIL_PROVIDER',      strtolower(getenv('WEBGANTT_MAIL_PROVIDER') ?: 'smtp'));
define('MAIL_SMTP_HOST',     getenv('WEBGANTT_SMTP_HOST')     ?: 'smtp-relay.brevo.com');
define('MAIL_SMTP_PORT',     (int)(getenv('WEBGANTT_SMTP_PORT') ?: 587));
define('MAIL_SMTP_USER',     getenv('WEBGANTT_SMTP_USER')     ?: 'apikey');
define('MAIL_SMTP_PASS',     getenv('WEBGANTT_SMTP_PASS')     ?: '');
define('MAIL_SMTP_SECURE',   getenv('WEBGANTT_SMTP_SECURE')   ?: 'tls');
define('MAIL_FROM_ADDR',     getenv('WEBGANTT_MAIL_FROM')     ?: 'gantt@ogma.mydns.jp');
define('MAIL_FROM_NAME',     getenv('WEBGANTT_MAIL_FROM_NAME')?: 'ガントチャート通知');
define('MAIL_API_KEY',       getenv('WEBGANTT_MAIL_API_KEY')  ?: '');
define('MAIL_APP_BASE_URL',  getenv('WEBGANTT_MAIL_APP_BASE_URL') ?: 'https://ogma.mydns.jp/WebGantt');

// ─── レスポンスヘルパー ─────────────────────────────────
function sendJson($data, int $statusCode = 200): void {
  http_response_code($statusCode);
  header('Content-Type: application/json; charset=utf-8');
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');
  header('Access-Control-Allow-Credentials: true');
  echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

function sendError(string $message, int $statusCode = 400): void {
  sendJson(['error' => $message], $statusCode);
}

// ─── DB接続 ─────────────────────────────────────────────
function getDb(): mysqli {
  static $db = null;
  if ($db === null) {
    $db = new mysqli(DB_HOST, DB_USER, DB_PASS, DB_NAME, DB_PORT);
    if ($db->connect_errno) {
      sendError('DB接続エラー: ' . $db->connect_error, 500);
    }
    $db->set_charset(DB_CHARSET);
  }
  return $db;
}

// ─── CORS プリフライト対応 ──────────────────────────────
function handlePreflight(): void {
  if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Max-Age: 86400');
    exit;
  }
}

// ─── 入力取得 ───────────────────────────────────────────
function getJsonBody(): array {
  $raw = file_get_contents('php://input');
  if (!$raw) return [];
  $data = json_decode($raw, true);
  return is_array($data) ? $data : [];
}

// ═══════════════════════════════════════════════════════════
// 認証関連関数 (Phase 2-A)
// ═══════════════════════════════════════════════════════════

/**
 * セッションIDを Cookie から取得
 */
function getSessionIdFromCookie(): ?string {
  // $_COOKIE から取得
  $cookieName = SESSION_COOKIE;
  if (isset($_COOKIE[$cookieName]) && !empty($_COOKIE[$cookieName])) {
    return $_COOKIE[$cookieName];
  }
  // ヘッダーから取得（Authorization: Bearer xxx 形式もサポート）
  $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    return $m[1];
  }
  return null;
}

/**
 * セッションIDを生成してDBに保存し、Cookieをセット
 */
function createSession(int $userId, string $displayName): array {
  $db = getDb();
  $sessionId = SESSION_PREFIX . bin2hex(random_bytes(32));
  $expiresAt = date('Y-m-d H:i:s', time() + SESSION_LIFETIME);
  $ip = $_SERVER['REMOTE_ADDR'] ?? null;

  $stmt = $db->prepare('INSERT INTO sessions (id, user_id, ip_address, expires_at) VALUES (?, ?, ?, ?)');
  $stmt->bind_param('siss', $sessionId, $userId, $ip, $expiresAt);
  $stmt->execute();

  // Cookieをセット（Phase A: 属性を環境変数から反映）
  // 参照: SESSION_COOKIE_SECURE / SESSION_COOKIE_SAMESITE（config.php 冒頭で定義）
  setcookie(SESSION_COOKIE, $sessionId, [
    'expires'  => time() + SESSION_LIFETIME,
    'path'     => '/',
    'httponly' => true,
    'secure'   => SESSION_COOKIE_SECURE,
    'samesite' => SESSION_COOKIE_SAMESITE,
  ]);

  return [
    'sessionId'   => $sessionId,
    'userId'      => $userId,
    'displayName' => $displayName,
    'expiresAt'   => $expiresAt,
  ];
}

/**
 * 現在ログイン中のユーザー情報を取得
 * @return array|null ユーザー情報 または null（未ログイン）
 */
function getCurrentUser(): ?array {
  $sessionId = getSessionIdFromCookie();
  if (!$sessionId) return null;

  $db = getDb();
  $stmt = $db->prepare(
    'SELECT s.id as sess_id, s.expires_at, u.id, u.username, u.display_name, u.role
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > NOW()'
  );
  $stmt->bind_param('s', $sessionId);
  $stmt->execute();
  $result = $stmt->get_result();
  $row = $result->fetch_assoc();

  if (!$row) return null;

  return [
    'id'           => (int)$row['id'],
    'username'     => $row['username'],
    'displayName'  => $row['display_name'],
    'role'         => $row['role'],
    'sessionId'    => $row['sess_id'],
  ];
}

/**
 * 認証必須のエンドポイント用
 * ログインしていない場合は 401 エラー
 */
function requireAuth(): array {
  $user = getCurrentUser();
  if (!$user) {
    sendError('認証が必要です', 401);
  }
  return $user;
}

// ═══════════════════════════════════════════════════════════
// プロジェクト権限関連関数 (Phase 2-B)
// ═══════════════════════════════════════════════════════════

/**
 * ユーザーが指定プロジェクトにアクセス可能か判定
 * admin は全プロジェクトに強制アクセス可能
 * @return bool
 */
function canAccessProject(mysqli $db, int $userId, string $role, string $projectId): bool {
  // 管理者は全プロジェクトにアクセス可能
  if ($role === 'admin') return true;
  // project_members に登録されているか確認
  $stmt = $db->prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?');
  $stmt->bind_param('si', $projectId, $userId);
  $stmt->execute();
  return (bool)$stmt->get_result()->fetch_assoc();
}

/**
 * ユーザーが指定プロジェクトの PJ管理権限を持つか判定
 * admin は全プロジェクトに対して PJ管理権限を持つ
 * @return bool
 */
function isProjectManager(mysqli $db, int $userId, string $role, string $projectId): bool {
  if ($role === 'admin') return true;
  $stmt = $db->prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role = 'manager'");
  $stmt->bind_param('si', $projectId, $userId);
  $stmt->execute();
  return (bool)$stmt->get_result()->fetch_assoc();
}

/**
 * プロジェクトの PJ管理者人数を取得
 */
function countProjectManagers(mysqli $db, string $projectId): int {
  $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM project_members WHERE project_id = ? AND role = 'manager'");
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  return (int)$row['cnt'];
}

/**
 * プロジェクトのメンバー一覧を取得
 */
function getProjectMembers(mysqli $db, string $projectId): array {
  $stmt = $db->prepare(
    'SELECT pm.id, pm.user_id, pm.role as pm_role, u.username, u.display_name, u.role as user_role
     FROM project_members pm
     JOIN users u ON pm.user_id = u.id
     WHERE pm.project_id = ?
     ORDER BY pm.role DESC, u.username'
  );
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $members = [];
  $result = $stmt->get_result();
  while ($row = $result->fetch_assoc()) {
    $members[] = [
      'id'          => (int)$row['id'],
      'user_id'     => (int)$row['user_id'],
      'username'    => $row['username'],
      'displayName' => $row['display_name'],
      'pmRole'      => $row['pm_role'],
      'userRole'    => $row['user_role'],
    ];
  }
  return $members;
}

/**
 * セッションを破棄（ログアウト）
 */
// ─── ロビープロジェクト取得 ──────────────────────────
/**
 * system_settings からロビープロジェクトIDを取得する。
 * レコードが存在しない場合は 'project-demo-01' をフォールバックとして返す。
 */
function getLobbyProjectId(mysqli $db): string {
  $result = $db->query("SELECT setting_value FROM system_settings WHERE setting_key = 'lobby_project_id' LIMIT 1");
  if ($result && $row = $result->fetch_assoc()) {
    return $row['setting_value'];
  }
  return 'project-demo-01'; // フォールバック
}

/**
 * 新規ユーザーの個人プロジェクトを作成し、初期設定を行う。
 * - 個人プロジェクトを作成（ユーザーがPJ管理権限）
 * - 切替メニュー設定: ロビー(sort_order=0) + 個人PJ(sort_order=1) を表示
 * - ログイン時表示プロジェクトを個人PJに設定
 * エラーは無視してスキップする（ユーザー作成自体は成功させる）。
 *
 * @param mysqli $db
 * @param int $userId       新規ユーザーID
 * @param string $username  ユーザー名（プロジェクトID生成に使用）
 * @param string $displayName 表示名（プロジェクト名に使用）
 */
function createPersonalProject(mysqli $db, int $userId, string $username, string $displayName): void {
  // 個人プロジェクトIDを生成（personal-{username}）
  $projectId = 'personal-' . $username;

  // 既に同名プロジェクトが存在する場合はIDにサフィックスを付ける
  $baseId = $projectId;
  $suffix = 1;
  while (true) {
    $chk = $db->prepare('SELECT id FROM projects WHERE project_id = ? LIMIT 1');
    $chk->bind_param('s', $projectId);
    $chk->execute();
    if (!$chk->get_result()->fetch_assoc()) break;
    $projectId = $baseId . '-' . $suffix;
    $suffix++;
  }

  // プロジェクト名
  $projectName = $displayName . 'の個人プロジェクト';

  // プロジェクト作成
  $stmt = $db->prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)');
  $stmt->bind_param('ss', $projectId, $projectName);
  if (!$stmt->execute()) {
    error_log('[config.php] 個人プロジェクト作成エラー: ' . $stmt->error);
    return;
  }

  // ユーザーにPJ管理権限を付与
  $managerRole = 'manager';
  $stmt = $db->prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  $stmt->bind_param('sis', $projectId, $userId, $managerRole);
  if (!$stmt->execute()) {
    error_log('[config.php] 個人PJ管理権限付与エラー: ' . $stmt->error);
  }

  // ── 切替メニュー個人設定: ロビー + 個人PJ の2件を登録 ──
  $lobbyId = getLobbyProjectId($db);

  // ロビープロジェクト（sort_order=0, is_visible=1）
  if ($lobbyId) {
    $sortOrder = 0;
    $isVisible = 1;
    $stmt = $db->prepare(
      'INSERT INTO user_project_settings (user_id, project_id, sort_order, is_visible)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_visible = VALUES(is_visible)'
    );
    $stmt->bind_param('isii', $userId, $lobbyId, $sortOrder, $isVisible);
    $stmt->execute();
  }

  // 個人プロジェクト（sort_order=1, is_visible=1）
  $sortOrder = 1;
  $isVisible = 1;
  $stmt = $db->prepare(
    'INSERT INTO user_project_settings (user_id, project_id, sort_order, is_visible)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_visible = VALUES(is_visible)'
  );
  $stmt->bind_param('isii', $userId, $projectId, $sortOrder, $isVisible);
  $stmt->execute();

  // ── ログイン時表示プロジェクトを個人PJに設定 ──
  $stmt = $db->prepare(
    'INSERT INTO user_login_project (user_id, project_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE project_id = VALUES(project_id)'
  );
  $stmt->bind_param('is', $userId, $projectId);
  $stmt->execute();
}

/**
 * 新規ユーザーをロビープロジェクトの member として登録する。
 * ロビープロジェクトが存在しない場合やエラーは無視してスキップする。
 */
function addUserToLobby(mysqli $db, int $userId): void {
  $lobbyId = getLobbyProjectId($db);
  if (!$lobbyId) return;

  // ロビープロジェクトが projects テーブルに存在するか確認
  $chk = $db->prepare('SELECT project_id FROM projects WHERE project_id = ? LIMIT 1');
  $chk->bind_param('s', $lobbyId);
  $chk->execute();
  if (!$chk->get_result()->fetch_assoc()) return; // 存在しなければスキップ

  // 既に登録済みでなければ member として追加
  $role = 'member';
  $stmt = $db->prepare('INSERT IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  $stmt->bind_param('sis', $lobbyId, $userId, $role);
  $stmt->execute();
}

function destroySession(): void {
  $sessionId = getSessionIdFromCookie();
  if ($sessionId) {
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM sessions WHERE id = ?');
    $stmt->bind_param('s', $sessionId);
    $stmt->execute();
  }
  // Cookieを削除（Phase A: 発行時と属性を一致させる）
  setcookie(SESSION_COOKIE, '', [
    'expires'  => time() - 3600,
    'path'     => '/',
    'httponly' => true,
    'secure'   => SESSION_COOKIE_SECURE,
    'samesite' => SESSION_COOKIE_SAMESITE,
  ]);
}