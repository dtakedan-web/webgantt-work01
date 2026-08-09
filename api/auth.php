<?php
/**
 * ガントチャート 認証API (Phase 2-A)
 * =====================================================
 * エンドポイント:
 *   POST   /api/auth.php?action=login     → ログイン
 *   POST   /api/auth.php?action=logout    → ログアウト
 *   GET    /api/auth.php?action=me        → 現在のユーザー情報
 *   POST   /api/auth.php?action=register  → ユーザー登録（adminのみ）
 *   GET    /api/auth.php?action=list      → ユーザー一覧（adminのみ）
 *   POST   /api/auth.php?action=changepw  → パスワード変更
 *   POST   /api/auth.php?action=resetpw   → 他ユーザーのパスワード再設定（adminのみ）
 *   POST   /api/auth.php?action=update_email → 自分自身のメールアドレス登録・変更（Phase 5-8）
 */

require_once __DIR__ . '/config.php';
handlePreflight();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$db     = getDb();

// ─── POST: login ───────────────────────────────────────
if ($method === 'POST' && $action === 'login') {
  $body    = getJsonBody();
  $username = trim($body['username'] ?? '');
  $password = $body['password'] ?? '';

  if (!$username || !$password) {
    sendError('ユーザー名とパスワードは必須です');
  }

  // ユーザー検索
  $stmt = $db->prepare('SELECT id, username, display_name, email, password_hash, role FROM users WHERE username = ?');
  $stmt->bind_param('s', $username);
  $stmt->execute();
  $user = $stmt->get_result()->fetch_assoc();

  if (!$user || !password_verify($password, $user['password_hash'])) {
    sendError('ユーザー名またはパスワードが正しくありません', 401);
  }

  // セッション作成
  $session = createSession((int)$user['id'], $user['display_name']);

  sendJson([
    'ok'       => true,
    'user' => [
      'id'          => (int)$user['id'],
      'username'    => $user['username'],
      'displayName' => $user['display_name'],
      'email'       => $user['email'],
      'role'        => $user['role'],
    ],
    'sessionId' => $session['sessionId'],
  ]);
}

// ─── POST: logout ──────────────────────────────────────
if ($method === 'POST' && $action === 'logout') {
  destroySession();
  sendJson(['ok' => true]);
}

// ─── GET: me (現在のユーザー情報) ─────────────────────
if ($method === 'GET' && $action === 'me') {
  $user = getCurrentUser();
  if (!$user) {
    sendJson(['authenticated' => false], 200);
  }

  // Phase 5-8: email を DB から追加取得(getCurrentUser() は email を含まない可能性があるため)
  $stmt = $db->prepare('SELECT email FROM users WHERE id = ?');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();
  $emailRow = $stmt->get_result()->fetch_assoc();
  $userEmail = $emailRow ? $emailRow['email'] : null;

  sendJson([
    'authenticated' => true,
    'sessionId'  => $user['sessionId'] ?? null,
    'user' => [
      'id'          => $user['id'],
      'username'    => $user['username'],
      'displayName' => $user['displayName'],
      'email'       => $userEmail,
      'role'        => $user['role'],
    ],
  ]);
}

// ─── POST: register (ユーザー登録・adminのみ) ─────────
if ($method === 'POST' && $action === 'register') {
  $currentUser = requireAuth();

  if ($currentUser['role'] !== 'admin') {
    sendError('ユーザー登録権限がありません', 403);
  }

  $body = getJsonBody();
  $username    = trim($body['username'] ?? '');
  $displayName = trim($body['displayName'] ?? '');
  $email       = trim($body['email'] ?? '');
  $password    = $body['password'] ?? '';
  $role        = $body['role'] ?? 'user';

  if (!$username || !$displayName || !$password) {
    sendError('username, displayName, password は必須です');
  }

  // Phase 5-8: email は任意。入力された場合は形式チェック
  if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendError('email の形式が正しくありません');
  }
  $emailValue = $email !== '' ? $email : null;

  if (!preg_match('/^[a-zA-Z0-9_-]{3,32}$/', $username)) {
    sendError('username は3〜32文字の英数字・ハイフン・アンダースコアのみ使用可能です');
  }

  if (strlen($password) < 6) {
    sendError('パスワードは6文字以上必要です');
  }

  if (!in_array($role, ['admin', 'user'], true)) {
    sendError('role は admin または user のみ指定可能です');
  }

  // 重複チェック
  $stmt = $db->prepare('SELECT id FROM users WHERE username = ?');
  $stmt->bind_param('s', $username);
  $stmt->execute();
  if ($stmt->get_result()->fetch_assoc()) {
    sendError('その username は既に存在します', 409);
  }

  // 作成
  $hash = password_hash($password, PASSWORD_BCRYPT);
  $stmt = $db->prepare('INSERT INTO users (username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)');
  $stmt->bind_param('sssss', $username, $displayName, $emailValue, $hash, $role);
  if (!$stmt->execute()) {
    sendError('ユーザー作成エラー: ' . $stmt->error, 500);
  }

  $newUserId = (int)$stmt->insert_id;

  // ロビープロジェクトへ自動追加（存在しない場合はスキップ）
  addUserToLobby($db, $newUserId);

  // 個人プロジェクトを自動作成（PJ管理権限・切替メニュー設定・ログイン時表示設定）
  createPersonalProject($db, $newUserId, $username, $displayName);

  sendJson([
    'ok' => true,
    'user' => [
      'id'          => $newUserId,
      'username'    => $username,
      'displayName' => $displayName,
      'email'       => $emailValue,
      'role'        => $role,
    ],
  ], 201);
}

// ─── GET: list (ユーザー一覧・adminのみ) ───────────────
if ($method === 'GET' && $action === 'list') {
  $currentUser = requireAuth();

  if ($currentUser['role'] !== 'admin') {
    sendError('権限がありません', 403);
  }

  $result = $db->query('SELECT id, username, display_name, email, role, created_at FROM users ORDER BY id');
  $users = [];
  while ($row = $result->fetch_assoc()) {
    $row['id'] = (int)$row['id'];
    $users[] = $row;
  }
  sendJson(['users' => $users]);
}

// ─── POST: changepw (パスワード変更) ──────────────────
if ($method === 'POST' && $action === 'changepw') {
  $currentUser = requireAuth();

  $body       = getJsonBody();
  $oldPass    = $body['oldPassword'] ?? '';
  $newPass    = $body['newPassword'] ?? '';

  if (!$oldPass || !$newPass) {
    sendError('oldPassword と newPassword は必須です');
  }

  if (strlen($newPass) < 6) {
    sendError('新パスワードは6文字以上必要です');
  }

  // 現在のパスワード確認
  $stmt = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
  $stmt->bind_param('i', $currentUser['id']);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();

  if (!password_verify($oldPass, $row['password_hash'])) {
    sendError('現在のパスワードが正しくありません', 401);
  }

  // 更新
  $hash = password_hash($newPass, PASSWORD_BCRYPT);
  $stmt = $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  $stmt->bind_param('si', $hash, $currentUser['id']);
  if (!$stmt->execute()) {
    sendError('パスワード更新エラー', 500);
  }

  sendJson(['ok' => true]);
}

// ─── POST: update_email (自分自身のメールアドレス登録・変更・Phase 5-8) ──
if ($method === 'POST' && $action === 'update_email') {
  $currentUser = requireAuth();

  $body  = getJsonBody();
  $email = trim($body['email'] ?? '');

  // 空文字は email 登録解除(NULL にする)として許可
  if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendError('email の形式が正しくありません');
  }
  $emailValue = $email !== '' ? $email : null;

  $stmt = $db->prepare('UPDATE users SET email = ? WHERE id = ?');
  $stmt->bind_param('si', $emailValue, $currentUser['id']);
  if (!$stmt->execute()) {
    sendError('メールアドレス更新エラー', 500);
  }

  sendJson(['ok' => true, 'email' => $emailValue]);
}

// ─── POST: update (ユーザー情報編集・adminのみ) ──────
if ($method === 'POST' && $action === 'update') {
  $currentUser = requireAuth();

  if ($currentUser['role'] !== 'admin') {
    sendError('ユーザー編集権限がありません', 403);
  }

  $body = getJsonBody();
  $targetId    = (int)($body['id'] ?? 0);
  $username    = trim($body['username'] ?? '');
  $displayName = trim($body['displayName'] ?? '');
  $email       = trim($body['email'] ?? '');
  $role        = $body['role'] ?? 'user';

  if (!$targetId) {
    sendError('id は必須です');
  }
  if (!$username || !$displayName) {
    sendError('ユーザー名と表示名は必須です');
  }
  // Phase 5-8: email は任意。入力された場合は形式チェック
  if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendError('email の形式が正しくありません');
  }
  $emailValue = $email !== '' ? $email : null;

  if (!preg_match('/^[a-zA-Z0-9_-]{3,32}$/', $username)) {
    sendError('ユーザー名は3〜32文字の英数字・ハイフン・アンダースコアのみ使用可能です');
  }
  if (!in_array($role, ['admin', 'user'], true)) {
    sendError('role は admin または user のみ指定可能です');
  }

  // 重複チェック（自分以外）
  $stmt = $db->prepare('SELECT id FROM users WHERE username = ? AND id != ?');
  $stmt->bind_param('si', $username, $targetId);
  $stmt->execute();
  if ($stmt->get_result()->fetch_assoc()) {
    sendError('その username は既に存在します', 409);
  }

  // 存在確認
  $stmt = $db->prepare('SELECT id FROM users WHERE id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();
  if (!$stmt->get_result()->fetch_assoc()) {
    sendError('指定されたユーザーが見つかりません', 404);
  }

  // 更新
  $stmt = $db->prepare('UPDATE users SET username = ?, display_name = ?, email = ?, role = ? WHERE id = ?');
  $stmt->bind_param('ssssi', $username, $displayName, $emailValue, $role, $targetId);
  if (!$stmt->execute()) {
    sendError('ユーザー更新エラー: ' . $stmt->error, 500);
  }

  sendJson(['ok' => true, 'user' => [
    'id'          => $targetId,
    'username'    => $username,
    'displayName' => $displayName,
    'email'       => $emailValue,
    'role'        => $role,
  ]]);
}

// ─── POST: delete (ユーザー削除・adminのみ) ─────────
if ($method === 'POST' && $action === 'delete') {
  $currentUser = requireAuth();

  if ($currentUser['role'] !== 'admin') {
    sendError('ユーザー削除権限がありません', 403);
  }

  $body = getJsonBody();
  $targetId = (int)($body['id'] ?? 0);

  if (!$targetId) {
    sendError('id は必須です');
  }

  // 自分自身は削除不可
  if ($targetId === $currentUser['id']) {
    sendError('自分自身を削除することはできません', 400);
  }

  // 削除対象の存在確認
  $stmt = $db->prepare('SELECT username FROM users WHERE id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();
  $target = $stmt->get_result()->fetch_assoc();

  if (!$target) {
    sendError('指定されたユーザーが見つかりません', 404);
  }

  $targetUsername = $target['username'];

  // ── 個人プロジェクトを特定して削除 ──
  // 個人プロジェクトIDのパターン: personal-{username} および personal-{username}-* （サフィックス付き）
  // LIKE 検索で該当プロジェクトを全て取得
  $personalPattern = 'personal-' . $targetUsername . '%';
  $stmt = $db->prepare('SELECT project_id FROM projects WHERE project_id LIKE ?');
  $stmt->bind_param('s', $personalPattern);
  $stmt->execute();
  $personalResult = $stmt->get_result();
  $personalProjectIds = [];
  while ($row = $personalResult->fetch_assoc()) {
    $personalProjectIds[] = $row['project_id'];
  }

  // 個人プロジェクトが存在する場合は関連データを全て削除
  foreach ($personalProjectIds as $pid) {
    // プロジェクトメンバー権限
    $stmt = $db->prepare('DELETE FROM project_members WHERE project_id = ?');
    $stmt->bind_param('s', $pid);
    $stmt->execute();

    // 操作ログ
    $stmt = $db->prepare('DELETE FROM operation_logs WHERE project_id = ?');
    $stmt->bind_param('s', $pid);
    $stmt->execute();

    // 他ユーザーの切替メニュー設定（個人PJを表示設定に含めている可能性）
    $stmt = $db->prepare('DELETE FROM user_project_settings WHERE project_id = ?');
    $stmt->bind_param('s', $pid);
    $stmt->execute();

    // 他ユーザーのビュー設定（個人PJのビュー設定が残っている可能性）
    $stmt = $db->prepare('DELETE FROM user_view_settings WHERE project_id = ?');
    $stmt->bind_param('s', $pid);
    $stmt->execute();

    // プロジェクト本体を削除
    $stmt = $db->prepare('DELETE FROM projects WHERE project_id = ?');
    $stmt->bind_param('s', $pid);
    $stmt->execute();
  }

  // ── ユーザー関連データを全て削除（外部キー制約がないため手動でクリーンアップ） ──
  // 1) セッション
  $stmt = $db->prepare('DELETE FROM sessions WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  // 2) プロジェクトメンバー権限
  $stmt = $db->prepare('DELETE FROM project_members WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  // 3) プロジェクト切替メニュー個人設定
  $stmt = $db->prepare('DELETE FROM user_project_settings WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  // 4) ログイン時表示プロジェクト設定
  $stmt = $db->prepare('DELETE FROM user_login_project WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  // 5) ユーザー個別ビュー設定 (Phase 2-D)
  $stmt = $db->prepare('DELETE FROM user_view_settings WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  // ── ユーザー本体を削除 ──
  $stmt = $db->prepare('DELETE FROM users WHERE id = ?');
  $stmt->bind_param('i', $targetId);
  if (!$stmt->execute()) {
    sendError('ユーザー削除エラー: ' . $stmt->error, 500);
  }

  sendJson(['ok' => true, 'deleted' => $target['username']]);
}

// ─── POST: resetpw (他ユーザーのパスワード再設定・adminのみ) ──
if ($method === 'POST' && $action === 'resetpw') {
  $currentUser = requireAuth();

  if ($currentUser['role'] !== 'admin') {
    sendError('他ユーザーのパスワード再設定権限がありません', 403);
  }

  $body    = getJsonBody();
  $targetId = (int)($body['id'] ?? 0);
  $newPass  = $body['newPassword'] ?? '';

  if (!$targetId) {
    sendError('id は必須です');
  }
  if (!$newPass) {
    sendError('newPassword は必須です');
  }
  if (strlen($newPass) < 6) {
    sendError('新パスワードは6文字以上必要です');
  }

  // 対象ユーザーの存在確認
  $stmt = $db->prepare('SELECT username, display_name FROM users WHERE id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();
  $target = $stmt->get_result()->fetch_assoc();
  if (!$target) {
    sendError('指定されたユーザーが見つかりません', 404);
  }

  // パスワード更新
  $hash = password_hash($newPass, PASSWORD_BCRYPT);
  $stmt = $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  $stmt->bind_param('si', $hash, $targetId);
  if (!$stmt->execute()) {
    sendError('パスワード再設定エラー: ' . $stmt->error, 500);
  }

  // 対象ユーザーのセッションを全削除（再設定後は再ログインが必要）
  $stmt = $db->prepare('DELETE FROM sessions WHERE user_id = ?');
  $stmt->bind_param('i', $targetId);
  $stmt->execute();

  sendJson(['ok' => true, 'username' => $target['username']]);
}

// ─── 未対応 ────────────────────────────────────────────
sendError('未対応のアクション: ' . $action, 404);
