<?php
/**
 * ガントチャート プロジェクトAPI (Phase 2-B)
 * =====================================================
 * Phase 2-B 変更点:
 *   - プロジェクト単位のアクセス権限管理
 *   - 作成者に自動的に PJ管理権限を付与
 *   - admin は全プロジェクトに強制アクセス可能
 *   - メンバー管理API（追加・削除・権限変更）
 *   - アクセス権限のないプロジェクトは閲覧・編集不可
 *
 * エンドポイント:
 *   GET    /api/projects.php                       → プロジェクト一覧（アクセス可能なもののみ）
 *   POST   /api/projects.php                       → プロジェクト作成（作成者=PJ管理）
 *   GET    /api/projects.php?id=XXX                → プロジェクト詳細（要アクセス権限）
 *   DELETE /api/projects.php?id=XXX                → プロジェクト削除（要PJ管理権限）
 *   POST   /api/projects.php?action=rename         → プロジェクト名変更（要PJ管理権限）
 *   GET    /api/projects.php?action=members&id=XXX → メンバー一覧（要アクセス権限）
 *   GET    /api/projects.php?action=candidateUsers&id=XXX → 追加候補ユーザー一覧（要PJ管理権限）
 *   POST   /api/projects.php?action=addMember      → メンバー追加（要PJ管理権限・ロビーは管理者のみ）
 *   POST   /api/projects.php?action=removeMember   → メンバー削除（要PJ管理権限・ロビーは管理者のみ）
 *   POST   /api/projects.php?action=changeRole     → メンバー権限変更（要PJ管理権限・ロビーは管理者のみ）
 *   GET    /api/projects.php?action=projectSettings   → プロジェクト切替メニュー個人設定取得
 *   POST   /api/projects.php?action=saveProjectSettings → プロジェクト切替メニュー個人設定保存
 *   GET    /api/projects.php?action=loginProject       → ログイン時表示プロジェクト取得
 *   POST   /api/projects.php?action=setLoginProject     → ログイン時表示プロジェクト設定
 *   GET    /api/projects.php?action=opLogs&id=XXX       → 操作履歴取得（要アクセス権限）
 */

require_once __DIR__ . '/config.php';
handlePreflight();

// 全エンドポイント認証必須
$user = requireAuth();
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$db     = getDb();

$userId = (int)$user['id'];
$userRole = $user['role'];

// ─── GET: 一覧 or 詳细 ────────────────────────────────
if ($method === 'GET' && $action === '') {
  $id = $_GET['id'] ?? null;

  if ($id) {
    // ── プロジェクト詳細 ──
    if (!canAccessProject($db, $userId, $userRole, $id)) {
      sendError('このプロジェクトにアクセスする権限がありません', 403);
    }

    $stmt = $db->prepare('SELECT id, project_id, name, snapshot, version, snapshot_size, created_at, updated_at FROM projects WHERE project_id = ?');
    $stmt->bind_param('s', $id);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result->fetch_assoc();

    if (!$row) {
      sendError('プロジェクトが見つかりません: ' . $id, 404);
    }

    $row['snapshot']      = $row['snapshot'] ? json_decode($row['snapshot'], true) : null;
    $row['id']            = (int)$row['id'];
    $row['version']       = (int)$row['version'];
    $row['snapshot_size'] = (int)$row['snapshot_size'];
    // アクセス権限情報を付加
    $row['canManage']     = isProjectManager($db, $userId, $userRole, $id);

    sendJson(['project' => $row]);
  } else {
    // ── プロジェクト一覧（アクセス可能なもののみ）──
    if ($userRole === 'admin') {
      // admin は全プロジェクト
      // admin: 全プロジェクト + ユーザー個人設定(sort_order/is_visible)をJOIN
      $stmt = $db->prepare(
        'SELECT p.id, p.project_id, p.name, p.version, p.created_at, p.updated_at,
                COALESCE(ups.sort_order, 999) AS sort_order,
                COALESCE(ups.is_visible, 1)   AS is_visible
         FROM projects p
         LEFT JOIN user_project_settings ups ON ups.project_id = p.project_id AND ups.user_id = ?
         ORDER BY COALESCE(ups.sort_order, 999) ASC, p.updated_at DESC'
      );
      $stmt->bind_param('i', $userId);
      $stmt->execute();
      $result = $stmt->get_result();
    } else {
      // 一般ユーザーは project_members に登録されているプロジェクトのみ
      // 一般ユーザー: メンバー登録プロジェクト + 個人設定(sort_order/is_visible)をJOIN
      $stmt = $db->prepare(
        'SELECT p.id, p.project_id, p.name, p.version, p.created_at, p.updated_at,
                COALESCE(ups.sort_order, 999) AS sort_order,
                COALESCE(ups.is_visible, 1)   AS is_visible
         FROM projects p
         INNER JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = ?
         LEFT JOIN  user_project_settings ups ON ups.project_id = p.project_id AND ups.user_id = ?
         ORDER BY COALESCE(ups.sort_order, 999) ASC, p.updated_at DESC'
      );
      $stmt->bind_param('ii', $userId, $userId);
      $stmt->execute();
      $result = $stmt->get_result();
    }

    $projects = [];
    while ($row = $result->fetch_assoc()) {
      $row['id']         = (int)$row['id'];
      $row['version']    = (int)$row['version'];
      $row['sort_order'] = (int)$row['sort_order'];
      $row['is_visible'] = (int)$row['is_visible'];
      // PJ管理権限の有無を付加
      $row['canManage'] = isProjectManager($db, $userId, $userRole, $row['project_id']);
      $projects[] = $row;
    }
    sendJson(['projects' => $projects]);
  }
}

// ─── POST: プロジェクト作成 ───────────────────────────
if ($method === 'POST' && $action === '') {
  $body = getJsonBody();
  $name = trim($body['name'] ?? '');
  $customId = trim($body['project_id'] ?? '');

  if (!$name) {
    sendError('プロジェクト名は必須です');
  }

  if ($customId) {
    if (!preg_match('/^[a-zA-Z0-9_-]+$/', $customId)) {
      sendError('project_id は英数字・ハイフン・アンダースコアのみ使用可能です');
    }
    $projectId = $customId;
  } else {
    $projectId = 'project-' . substr(bin2hex(random_bytes(8)), 0, 12);
  }

  $stmt = $db->prepare('SELECT id FROM projects WHERE project_id = ?');
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  if ($stmt->get_result()->fetch_assoc()) {
    sendError('その project_id は既に存在します: ' . $projectId, 409);
  }

  // プロジェクト作成
  $stmt = $db->prepare('INSERT INTO projects (project_id, name) VALUES (?, ?)');
  $stmt->bind_param('ss', $projectId, $name);
  if (!$stmt->execute()) {
    sendError('プロジェクト作成エラー: ' . $stmt->error, 500);
  }

  // 作成者に PJ管理権限を付与
  $stmt = $db->prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  $managerRole = 'manager';
  $stmt->bind_param('sis', $projectId, $userId, $managerRole);
  if (!$stmt->execute()) {
    // 失敗してもプロジェクトは残す（admin ならアクセス可能）
    error_log('[projects.php] PJ管理権限付与エラー: ' . $stmt->error);
  }

  sendJson(['ok' => true, 'project_id' => $projectId], 201);
}

// ─── POST: rename (プロジェクト名変更) ───────────────
if ($method === 'POST' && $action === 'rename') {
  $body = getJsonBody();
  $projectId = trim($body['project_id'] ?? '');
  $newName   = trim($body['name'] ?? '');

  if (!$projectId || !$newName) {
    sendError('project_id と name は必須です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $projectId)) {
    sendError('プロジェクト名の変更権限がありません', 403);
  }

  $stmt = $db->prepare('UPDATE projects SET name = ? WHERE project_id = ?');
  $stmt->bind_param('ss', $newName, $projectId);
  if (!$stmt->execute()) {
    sendError('プロジェクト名変更エラー: ' . $stmt->error, 500);
  }

  if ($stmt->affected_rows === 0) {
    $check = $db->prepare('SELECT id FROM projects WHERE project_id = ?');
    $check->bind_param('s', $projectId);
    $check->execute();
    if (!$check->get_result()->fetch_assoc()) {
      sendError('プロジェクトが見つかりません: ' . $projectId, 404);
    }
  }

  sendJson(['ok' => true, 'name' => $newName]);
}

// ─── DELETE: プロジェクト削除 ─────────────────────────
if ($method === 'DELETE') {
  $id = $_GET['id'] ?? null;
  if (!$id) {
    sendError('id パラメータは必須です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $id)) {
    sendError('プロジェクトの削除権限がありません', 403);
  }

  // ロビープロジェクトの削除は管理者のみ許可
  $lobbyId = getLobbyProjectId($db);
  if ($id === $lobbyId && $userRole !== 'admin') {
    sendError('ロビープロジェクトは管理者のみ削除できます', 403);
  }

  // プロジェクト存在確認
  $stmt = $db->prepare('SELECT id FROM projects WHERE project_id = ?');
  $stmt->bind_param('s', $id);
  $stmt->execute();
  if (!$stmt->get_result()->fetch_assoc()) {
    sendError('プロジェクトが見つかりません: ' . $id, 404);
  }

  // メンバー権限を先に削除
  $stmt = $db->prepare('DELETE FROM project_members WHERE project_id = ?');
  $stmt->bind_param('s', $id);
  $stmt->execute();

  // プロジェクト削除
  $stmt = $db->prepare('DELETE FROM projects WHERE project_id = ?');
  $stmt->bind_param('s', $id);
  if (!$stmt->execute()) {
    sendError('プロジェクト削除エラー: ' . $stmt->error, 500);
  }

  // 操作ログも削除
  $stmt2 = $db->prepare('DELETE FROM operation_logs WHERE project_id = ?');
  $stmt2->bind_param('s', $id);
  $stmt2->execute();

  sendJson(['ok' => true]);
}

// ─── GET: members (メンバー一覧) ──────────────────────
if ($method === 'GET' && $action === 'members') {
  $projectId = $_GET['id'] ?? '';
  if (!$projectId) {
    sendError('id パラメータは必須です');
  }

  // アクセス権限チェック
  if (!canAccessProject($db, $userId, $userRole, $projectId)) {
    sendError('このプロジェクトにアクセスする権限がありません', 403);
  }

  $members = getProjectMembers($db, $projectId);
  // 現在のユーザーが PJ管理権限を持つかを付加
  $canManage = isProjectManager($db, $userId, $userRole, $projectId);
  sendJson(['members' => $members, 'canManage' => $canManage]);
}

// ─── GET: candidateUsers (追加候補ユーザー一覧) ──────
if ($method === 'GET' && $action === 'candidateUsers') {
  $projectId = $_GET['id'] ?? '';
  if (!$projectId) {
    sendError('id パラメータは必須です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $projectId)) {
    sendError('候補ユーザーを取得する権限がありません', 403);
  }

  // 管理者(role='admin')以外のユーザーのうち、
  // まだこのプロジェクトのメンバーでないユーザーを取得
  $stmt = $db->prepare(
    'SELECT u.id, u.username, u.display_name
     FROM users u
     WHERE u.role != ?
       AND u.id NOT IN (
         SELECT pm.user_id FROM project_members pm WHERE pm.project_id = ?
       )
     ORDER BY u.username'
  );
  $adminRole = 'admin';
  $stmt->bind_param('ss', $adminRole, $projectId);
  $stmt->execute();
  $result = $stmt->get_result();

  $candidates = [];
  while ($row = $result->fetch_assoc()) {
    $row['id'] = (int)$row['id'];
    $candidates[] = $row;
  }
  sendJson(['candidates' => $candidates]);
}

// ─── POST: addMember (メンバー追加) ───────────────────
if ($method === 'POST' && $action === 'addMember') {
  $body = getJsonBody();
  $projectId = trim($body['project_id'] ?? '');
  $targetUsername = trim($body['username'] ?? '');
  $targetRole = $body['pmRole'] ?? 'member';

  if (!$projectId || !$targetUsername) {
    sendError('project_id と username は必須です');
  }

  if (!in_array($targetRole, ['manager', 'member'], true)) {
    sendError('pmRole は manager または member のみ指定可能です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $projectId)) {
    sendError('メンバー追加権限がありません', 403);
  }

  // ロビープロジェクトのメンバー変更は管理者のみ
  if ($projectId === getLobbyProjectId($db) && $userRole !== 'admin') {
    sendError('ロビープロジェクトのメンバー変更は管理者のみ可能です', 403);
  }

  // 対象ユーザーを検索
  $stmt = $db->prepare('SELECT id, username, display_name, role FROM users WHERE username = ?');
  $stmt->bind_param('s', $targetUsername);
  $stmt->execute();
  $targetUser = $stmt->get_result()->fetch_assoc();

  if (!$targetUser) {
    sendError('指定されたユーザーが見つかりません: ' . $targetUsername, 404);
  }

  $targetUserId = (int)$targetUser['id'];

  // 既に登録されているか確認
  $stmt = $db->prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?');
  $stmt->bind_param('si', $projectId, $targetUserId);
  $stmt->execute();
  if ($stmt->get_result()->fetch_assoc()) {
    sendError('このユーザーは既にメンバーとして登録されています', 409);
  }

  // メンバー追加
  $stmt = $db->prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)');
  $stmt->bind_param('sis', $projectId, $targetUserId, $targetRole);
  if (!$stmt->execute()) {
    sendError('メンバー追加エラー: ' . $stmt->error, 500);
  }

  sendJson([
    'ok' => true,
    'member' => [
      'user_id'     => $targetUserId,
      'username'    => $targetUser['username'],
      'displayName' => $targetUser['display_name'],
      'pmRole'      => $targetRole,
      'userRole'    => $targetUser['role'],
    ],
  ], 201);
}

// ─── POST: removeMember (メンバー削除) ────────────────
if ($method === 'POST' && $action === 'removeMember') {
  $body = getJsonBody();
  $projectId = trim($body['project_id'] ?? '');
  $targetUserId = (int)($body['user_id'] ?? 0);

  if (!$projectId || !$targetUserId) {
    sendError('project_id と user_id は必須です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $projectId)) {
    sendError('メンバー削除権限がありません', 403);
  }

  // ロビープロジェクトのメンバー変更は管理者のみ
  if ($projectId === getLobbyProjectId($db) && $userRole !== 'admin') {
    sendError('ロビープロジェクトのメンバー変更は管理者のみ可能です', 403);
  }

  // 削除対象のメンバー情報を取得
  $stmt = $db->prepare(
    'SELECT pm.id, pm.role, u.username, u.display_name
     FROM project_members pm
     JOIN users u ON pm.user_id = u.id
     WHERE pm.project_id = ? AND pm.user_id = ?'
  );
  $stmt->bind_param('si', $projectId, $targetUserId);
  $stmt->execute();
  $targetMember = $stmt->get_result()->fetch_assoc();

  if (!$targetMember) {
    sendError('指定されたユーザーはこのプロジェクトのメンバーではありません', 404);
  }

  // 最後の PJ管理者は削除できない
  if ($targetMember['role'] === 'manager' && countProjectManagers($db, $projectId) <= 1) {
    sendError('最後のPJ管理者は削除できません。先に別のユーザーをPJ管理者に追加してください。', 400);
  }

  // メンバー削除
  $stmt = $db->prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?');
  $stmt->bind_param('si', $projectId, $targetUserId);
  if (!$stmt->execute()) {
    sendError('メンバー削除エラー: ' . $stmt->error, 500);
  }

  sendJson(['ok' => true, 'removed' => $targetMember['username']]);
}

// ─── POST: changeRole (メンバー権限変更) ──────────────
if ($method === 'POST' && $action === 'changeRole') {
  $body = getJsonBody();
  $projectId = trim($body['project_id'] ?? '');
  $targetUserId = (int)($body['user_id'] ?? 0);
  $newRole = $body['pmRole'] ?? '';

  if (!$projectId || !$targetUserId) {
    sendError('project_id と user_id は必須です');
  }

  if (!in_array($newRole, ['manager', 'member'], true)) {
    sendError('pmRole は manager または member のみ指定可能です');
  }

  // PJ管理権限チェック
  if (!isProjectManager($db, $userId, $userRole, $projectId)) {
    sendError('権限変更権限がありません', 403);
  }

  // ロビープロジェクトのメンバー変更は管理者のみ
  if ($projectId === getLobbyProjectId($db) && $userRole !== 'admin') {
    sendError('ロビープロジェクトのメンバー変更は管理者のみ可能です', 403);
  }

  // 対象メンバーの現在の権限を取得
  $stmt = $db->prepare('SELECT id, role FROM project_members WHERE project_id = ? AND user_id = ?');
  $stmt->bind_param('si', $projectId, $targetUserId);
  $stmt->execute();
  $targetMember = $stmt->get_result()->fetch_assoc();

  if (!$targetMember) {
    sendError('指定されたユーザーはこのプロジェクトのメンバーではありません', 404);
  }

  // manager → member に降格する場合、最後の PJ管理者でないか確認
  if ($targetMember['role'] === 'manager' && $newRole === 'member' && countProjectManagers($db, $projectId) <= 1) {
    sendError('最後のPJ管理者を降格できません。先に別のユーザーをPJ管理者にしてください。', 400);
  }

  // 権限更新
  $stmt = $db->prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?');
  $stmt->bind_param('ssi', $newRole, $projectId, $targetUserId);
  if (!$stmt->execute()) {
    sendError('権限変更エラー: ' . $stmt->error, 500);
  }

  sendJson(['ok' => true, 'pmRole' => $newRole]);
}

// ─── GET: projectSettings (個人設定取得) ─────────────────
if ($method === 'GET' && $action === 'projectSettings') {
  $stmt = $db->prepare(
    'SELECT ups.project_id, ups.sort_order, ups.is_visible
     FROM user_project_settings ups
     WHERE ups.user_id = ?
     ORDER BY ups.sort_order ASC'
  );
  $stmt->bind_param('i', $userId);
  $stmt->execute();
  $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);
  $settings = [];
  foreach ($rows as $r) {
    $settings[$r['project_id']] = [
      'sort_order' => (int)$r['sort_order'],
      'is_visible' => (int)$r['is_visible'],
    ];
  }
  sendJson(['settings' => $settings]);
}

// ─── POST: saveProjectSettings (個人設定保存) ─────────
if ($method === 'POST' && $action === 'saveProjectSettings') {
  $body     = getJsonBody();
  $settings = $body['settings'] ?? []; // [{project_id, sort_order, is_visible}, ...]

  if (!is_array($settings)) {
    sendError('settings は配列で送信してください');
  }

  // 既存設定を全削除してから再INSERT（UPSERT）
  foreach ($settings as $s) {
    $pid        = trim($s['project_id'] ?? '');
    $sortOrder  = (int)($s['sort_order'] ?? 999);
    $isVisible  = (int)($s['is_visible'] ?? 1) ? 1 : 0;

    if (!$pid) continue;

    // アクセス権があるプロジェクトのみ保存可（セキュリティ）
    if (!canAccessProject($db, $userId, $userRole, $pid)) continue;

    $stmt = $db->prepare(
      'INSERT INTO user_project_settings (user_id, project_id, sort_order, is_visible)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_visible = VALUES(is_visible)'
    );
    $stmt->bind_param('isii', $userId, $pid, $sortOrder, $isVisible);
    $stmt->execute();
  }

  sendJson(['ok' => true]);
}

// ─── GET: opLogs (操作履歴取得・要アクセス権限) ─────────
if ($method === 'GET' && $action === 'opLogs') {
  $projectId = trim($_GET['id'] ?? '');
  if (!$projectId) {
    sendError('id（project_id）は必須です');
  }

  // アクセス権限チェック
  if (!canAccessProject($db, $userId, $userRole, $projectId)) {
    sendError('このプロジェクトのアクセス権限がありません', 403);
  }

  // ページネーション
  $page     = max(0, (int)($_GET['page'] ?? 0));
  $perPage  = min(100, max(10, (int)($_GET['perPage'] ?? 50)));
  $offset   = $page * $perPage;

  // 総件数取得
  $stmt = $db->prepare('SELECT COUNT(*) as total FROM operation_logs WHERE project_id = ?');
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $total = (int)$stmt->get_result()->fetch_assoc()['total'];

  // 操作履歴取得（新しい順）
  $stmt = $db->prepare(
    'SELECT ol.id, ol.project_id, ol.op_type, ol.op_payload, ol.version, ol.user_id, ol.session_id, ol.created_at,
            u.username, u.display_name
     FROM operation_logs ol
     LEFT JOIN users u ON ol.user_id = u.username
     WHERE ol.project_id = ?
     ORDER BY ol.id DESC
     LIMIT ? OFFSET ?'
  );
  $stmt->bind_param('sii', $projectId, $perPage, $offset);
  $stmt->execute();
  $rows = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);

  $logs = [];
  foreach ($rows as $r) {
    $logs[] = [
      'id'          => (int)$r['id'],
      'op_type'     => $r['op_type'],
      'op_payload'  => $r['op_payload'] ? json_decode($r['op_payload'], true) : null,
      'version'     => (int)$r['version'],
      'user_id'     => $r['user_id'],
      'username'    => $r['username'],
      'display_name'=> $r['display_name'],
      'created_at'  => $r['created_at'],
    ];
  }

  sendJson([
    'logs'  => $logs,
    'total' => $total,
    'page'  => $page,
    'perPage' => $perPage,
    'totalPages' => (int)ceil($total / $perPage),
  ]);
}

// ─── GET: loginProject (ログイン時表示プロジェクト取得・全員) ──
if ($method === 'GET' && $action === 'loginProject') {
  $stmt = $db->prepare(
    'SELECT project_id FROM user_login_project WHERE user_id = ? LIMIT 1'
  );
  $stmt->bind_param('i', $userId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  if ($row && $row['project_id']) {
    // アクセス権があるか確認
    if (canAccessProject($db, $userId, $userRole, $row['project_id'])) {
      sendJson(['project_id' => $row['project_id']]);
    } else {
      // アクセス権がなくなったプロジェクトは無視（ロビーにフォールバック）
      sendJson(['project_id' => null]);
    }
  } else {
    sendJson(['project_id' => null]);
  }
}

// ─── POST: setLoginProject (ログイン時表示プロジェクト設定・全員) ──
if ($method === 'POST' && $action === 'setLoginProject') {
  $body       = getJsonBody();
  $projectId  = trim($body['project_id'] ?? '');

  if (!$projectId) {
    sendError('project_id は必須です');
  }

  // アクセス権があるプロジェクトのみ設定可
  if (!canAccessProject($db, $userId, $userRole, $projectId)) {
    sendError('このプロジェクトはアクセス権限がありません', 403);
  }

  // UPSERT（user_idは主キーなので1ユーザー1レコード）
  $stmt = $db->prepare(
    'INSERT INTO user_login_project (user_id, project_id)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE project_id = VALUES(project_id)'
  );
  $stmt->bind_param('is', $userId, $projectId);
  if ($stmt->execute()) {
    sendJson(['ok' => true, 'project_id' => $projectId]);
  } else {
    sendError('設定の保存に失敗しました', 500);
  }
}

// ─── GET: lobby (ロビープロジェクト取得・全員) ───────────
if ($method === 'GET' && $action === 'lobby') {
  $lobbyId = getLobbyProjectId($db);
  sendJson(['lobby_project_id' => $lobbyId]);
}

// ─── POST: setLobby (ロビープロジェクト変更・adminのみ) ──
if ($method === 'POST' && $action === 'setLobby') {
  if ($userRole !== 'admin') {
    sendError('管理者のみロビープロジェクトを変更できます', 403);
  }

  $body      = getJsonBody();
  $newLobby  = trim($body['project_id'] ?? '');
  if (!$newLobby) {
    sendError('project_id は必須です');
  }

  // 対象プロジェクトが存在するか確認
  $stmt = $db->prepare('SELECT project_id FROM projects WHERE project_id = ? LIMIT 1');
  $stmt->bind_param('s', $newLobby);
  $stmt->execute();
  if (!$stmt->get_result()->fetch_assoc()) {
    sendError('指定されたプロジェクトが存在しません', 404);
  }

  // 設定を UPSERT
  $stmt = $db->prepare(
    "INSERT INTO system_settings (setting_key, setting_value) VALUES ('lobby_project_id', ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)"
  );
  $stmt->bind_param('s', $newLobby);
  if (!$stmt->execute()) {
    sendError('設定更新エラー: ' . $stmt->error, 500);
  }

  sendJson(['ok' => true, 'lobby_project_id' => $newLobby]);
}

sendError('未対応のメソッド: ' . $method, 405);
