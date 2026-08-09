<?php
/**
 * ガントチャート API ヘルスチェック (Phase 2-A)
 * GET /api/health.php → { status: "ok", db: true/false, auth: true/false }
 */

require_once __DIR__ . '/config.php';

$db = getDb();
$dbOk = $db->ping();

// 認証テーブルの存在確認
$authOk = false;
if ($dbOk) {
  $result = $db->query("SHOW TABLES LIKE 'users'");
  $authOk = $result && $result->num_rows > 0;
}

$currentUser = getCurrentUser();

sendJson([
  'status'        => 'ok',
  'db'            => $dbOk,
  'auth'          => $authOk,
  'authenticated' => $currentUser !== null,
  'ts'            => round(microtime(true) * 1000),
]);
