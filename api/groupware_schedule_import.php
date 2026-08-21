<?php
/**
 * 社内グループウェア（intra-mart）スケジュール連携（ブラウザ拡張機能方式）— サーバー側新規API
 * ============================================================
 * 参照: docs/groupware-schedule-import-design.md（10節・11節）
 *
 * 【重要・設計上の位置づけ】
 * 本ファイルは api/teams_excel_import.php と全く同じパターン（拡張機能からの
 * タスク追加時にサーバー側が projects.snapshot を直接書き換える方式Q）を
 * ほぼそのまま踏襲する。intra-martへのアクセス自体（gwlogin経由のSSOログイン・
 * find_group_week呼び出し）はブラウザ拡張機能側（社内LAN上のユーザーPC）で
 * 完結しており、本ファイルはあくまで「拡張機能が抽出・整形済みのタスク配列」を
 * 受け取ってDBに書き込むだけである。
 *
 * 【コード分離方針（設計書11節の確定要望）】
 * 本機能は「特殊（汎用性は低い）」機能として、既存コードから完全に分離する。
 *   - 本ファイル1つに全アクションを集約し、他の api/*.php には一切変更を
 *     加えない（api/config.php の共通ヘルパーのみ再利用する）
 *   - 新規DBテーブルは groupware_schedule_ プレフィックスで統一する
 *     （docs/sql/2026-08-21_groupware_schedule_extension_tokens.sql）
 *   - 将来この機能を廃止する場合は、
 *       (1) 本ファイルの削除
 *       (2) groupware_schedule_* テーブル群の DROP TABLE
 *       (3) account.html 内「グループウェア連携」セクションの削除
 *     の3ステップで完全撤去できる。
 *
 * エンドポイント:
 *   【account.html から呼ばれる系（既存Cookieセッション認証・requireAuth()）】
 *   GET  /api/groupware_schedule_import.php?action=token_status  → 発行済みトークンの有無・発行日時を取得
 *   POST /api/groupware_schedule_import.php?action=issue_token   → 新規トークン発行（旧トークンは自動失効）
 *   POST /api/groupware_schedule_import.php?action=revoke_token  → トークン無効化
 *
 *   【ブラウザ拡張機能から呼ばれる系（拡張機能専用Bearerトークン認証）】
 *   GET  /api/groupware_schedule_import.php?action=token_verify   → トークンの有効性確認（拡張機能の起動時チェック用）
 *   GET  /api/groupware_schedule_import.php?action=list_projects  → アクセス可能なプロジェクト一覧＋メンバー一覧を取得
 *   POST /api/groupware_schedule_import.php?action=import_tasks   → 選択済みタスク配列を受け取り、対象プロジェクトのsnapshotに追加
 *
 * import_tasks実行後のgantt-ws通知（Teams Excel連携で2026-08-19に後追い対応した
 * 「開いたまま放置→後でリロード時にタスクが消える」事故防止策）は、本機能では
 * 設計書3節の方針どおり初版から実装する。
 */

require_once __DIR__ . '/config.php';
handlePreflight();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$db     = getDb();

// ═══════════════════════════════════════════════════════════
// 拡張機能専用トークン: ヘルパー関数群
// （設計書10.1節: sessions テーブルには一切触れない別体系）
// ═══════════════════════════════════════════════════════════

/**
 * 新規トークンを生成し、DBには SHA-256 ハッシュのみを保存する（生トークンは
 * 発行時に1回だけ呼び出し元へ返却し、以降は復元不可能な運用とする）。
 * 1ユーザーにつき有効なトークンは常に1つのみ（再発行時は upsert で旧トークンを
 * 自動失効させる。teams_excel_extension_tokens 等と同じ UNIQUE KEY uq_user_id パターン）。
 */
function issueExtensionToken(mysqli $db, int $userId): string {
  $rawToken = 'gws_' . bin2hex(random_bytes(32)); // gws_ = GroupWare Schedule の意（tex_等の他トークン種別と見分けやすくする）
  $tokenHash = hash('sha256', $rawToken);

  $stmt = $db->prepare(
    'INSERT INTO groupware_schedule_extension_tokens (user_id, token_hash)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), last_used_at = NULL'
  );
  $stmt->bind_param('is', $userId, $tokenHash);
  if (!$stmt->execute()) {
    error_log('[groupware_schedule_import.php] issueExtensionToken: DB保存エラー: ' . $stmt->error);
    sendError('トークンの発行に失敗しました。しばらくしてから再度お試しください', 500);
  }

  return $rawToken;
}

/**
 * Authorization ヘッダーの値を取得する。
 * サーバー環境（Apache+mod_php / PHP-FPM+FastCGI 等）によっては
 * $_SERVER['HTTP_AUTHORIZATION'] にAuthorizationヘッダーが渡って来ない
 * ことがあるため、getallheaders() / apache_request_headers() で
 * フォールバックする（Teams Excel連携と同じ対応）。
 */
function getAuthorizationHeaderValue(): string {
  if (!empty($_SERVER['HTTP_AUTHORIZATION'])) {
    return $_SERVER['HTTP_AUTHORIZATION'];
  }
  // 一部のFastCGI環境ではリダイレクトされた値に入ることがある
  if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
    return $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
  }
  if (function_exists('getallheaders')) {
    $headers = getallheaders();
    foreach ($headers as $name => $value) {
      if (strcasecmp($name, 'Authorization') === 0) {
        return $value;
      }
    }
  }
  if (function_exists('apache_request_headers')) {
    $headers = apache_request_headers();
    foreach ($headers as $name => $value) {
      if (strcasecmp($name, 'Authorization') === 0) {
        return $value;
      }
    }
  }
  return '';
}

/**
 * Authorization: Bearer <token> ヘッダーから拡張機能専用トークンを取り出し、
 * 有効なユーザーIDを返す。無効・未指定の場合は null。
 * 既存の getSessionIdFromCookie() は sessions テーブルに紐づく別体系のため、
 * 本関数はそれとは独立に自前で Authorization ヘッダーを読む。
 */
function getUserIdFromExtensionToken(mysqli $db): ?int {
  $authHeader = getAuthorizationHeaderValue();
  if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    return null;
  }
  $rawToken = trim($m[1]);
  if ($rawToken === '' || !str_starts_with($rawToken, 'gws_')) {
    return null;
  }
  $tokenHash = hash('sha256', $rawToken);

  $stmt = $db->prepare('SELECT user_id FROM groupware_schedule_extension_tokens WHERE token_hash = ? LIMIT 1');
  $stmt->bind_param('s', $tokenHash);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  if (!$row) return null;

  // 利用日時を更新（不正利用検知の参考表示用、失敗しても処理は継続する）
  $upd = $db->prepare('UPDATE groupware_schedule_extension_tokens SET last_used_at = NOW() WHERE user_id = ?');
  $upd->bind_param('i', $row['user_id']);
  @$upd->execute();

  return (int)$row['user_id'];
}

/**
 * 拡張機能トークン認証必須のエンドポイント用。
 * 認証済みユーザー情報（getCurrentUser() と互換な最小限の配列）を返す。
 */
function requireExtensionAuth(mysqli $db): array {
  $userId = getUserIdFromExtensionToken($db);
  if ($userId === null) {
    sendError('拡張機能の認証トークンが無効です。account.htmlで再発行してください', 401);
  }

  $stmt = $db->prepare('SELECT id, username, display_name, role FROM users WHERE id = ?');
  $stmt->bind_param('i', $userId);
  $stmt->execute();
  $user = $stmt->get_result()->fetch_assoc();
  if (!$user) {
    sendError('ユーザーが見つかりません', 401);
  }

  return [
    'id'          => (int)$user['id'],
    'username'    => $user['username'],
    'displayName' => $user['display_name'],
    'role'        => $user['role'],
  ];
}

/**
 * gantt-ws（WebSocketサーバー、ポート3001、127.0.0.1限定）へ内部HTTP POSTを
 * 送信し、対象プロジェクトをメモリ上にroomとして保持している（＝誰かが
 * ブラウザで開いている）クライアント全員に、最新のsnapshotを強制配信する。
 * api/teams_excel_import.php の _pushGanttFullSyncToWs() と全く同じ実装。
 * gantt-ws側にroomが存在しない場合は何もされない（実害なし）。
 * 通信に失敗しても本処理（import_tasksの成否）には影響させない
 * （エラー抑制・タイムアウト短め）。
 */
function _pushGanttFullSyncToWs(string $projectId, array $snapshot, int $version): void {
  $payload = json_encode(
    ['projectId' => $projectId, 'snapshot' => $snapshot, 'version' => $version],
    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
  );
  $ch = curl_init('http://127.0.0.1:3001/internal/full_sync_push');
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 2,
    CURLOPT_CONNECTTIMEOUT => 1,
  ]);
  @curl_exec($ch);
  curl_close($ch);
}

// ═══════════════════════════════════════════════════════════
// GET: token_status（account.html用・発行済みトークンの有無を取得）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'token_status') {
  $user = requireAuth();

  $stmt = $db->prepare('SELECT created_at, last_used_at FROM groupware_schedule_extension_tokens WHERE user_id = ? LIMIT 1');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();

  if (!$row) {
    sendJson(['issued' => false]);
  }

  sendJson([
    'issued'     => true,
    'issuedAt'   => $row['created_at'],
    'lastUsedAt' => $row['last_used_at'],
  ]);
}

// ═══════════════════════════════════════════════════════════
// POST: issue_token（account.html用・新規発行、旧トークンは自動失効）
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'issue_token') {
  $user = requireAuth();
  $rawToken = issueExtensionToken($db, (int)$user['id']);

  // 生トークンはこの応答でのみ返却する（DBには保存しないため、これ以降は再表示不可）
  sendJson(['ok' => true, 'token' => $rawToken]);
}

// ═══════════════════════════════════════════════════════════
// POST: revoke_token（account.html用・無効化）
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'revoke_token') {
  $user = requireAuth();

  $stmt = $db->prepare('DELETE FROM groupware_schedule_extension_tokens WHERE user_id = ?');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();

  sendJson(['ok' => true]);
}

// ═══════════════════════════════════════════════════════════
// GET: token_verify（拡張機能用・起動時の疎通確認）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'token_verify') {
  $user = requireExtensionAuth($db);
  sendJson(['ok' => true, 'displayName' => $user['displayName']]);
}

// ═══════════════════════════════════════════════════════════
// GET: list_projects（拡張機能用・アクセス可能なプロジェクト一覧＋メンバー一覧）
// 設計書8.4節・10.3節: サーバー側でassignee正規化の二重チェックを行うため、
// メンバー表示名一覧を拡張機能へ渡す（Teams Excel連携と同じ考え方）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'list_projects') {
  $user = requireExtensionAuth($db);
  $userId = $user['id'];
  $userRole = $user['role'];

  if ($userRole === 'admin') {
    $stmt = $db->prepare('SELECT project_id, name FROM projects ORDER BY updated_at DESC');
    $stmt->execute();
    $result = $stmt->get_result();
  } else {
    $stmt = $db->prepare(
      'SELECT p.project_id, p.name
       FROM projects p
       INNER JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = ?
       ORDER BY p.updated_at DESC'
    );
    $stmt->bind_param('i', $userId);
    $stmt->execute();
    $result = $stmt->get_result();
  }

  $projects = [];
  while ($row = $result->fetch_assoc()) {
    $members = getProjectMembers($db, $row['project_id']);
    $projects[] = [
      'projectId' => $row['project_id'],
      'name'      => $row['name'],
      // assigneeの正規化（サーバー側二重チェック）用に表示名一覧のみを渡す
      // （メールアドレス等の個人情報は含めない）
      'members'   => array_map(function ($m) { return $m['displayName']; }, $members),
    ];
  }

  sendJson(['projects' => $projects]);
}

// ═══════════════════════════════════════════════════════════
// POST: import_tasks（拡張機能用・snapshot直接書き込み、方式Qの核心部分）
// 設計書10.2節: SELECT ... FOR UPDATE によるDB行ロックで排他制御を行う。
// 同時編集中ブラウザとの競合（後勝ち）は本フェーズでは非対応方針（Teams Excel連携と同じ）。
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'import_tasks') {
  $user = requireExtensionAuth($db);
  $userId = $user['id'];
  $userRole = $user['role'];

  $body = getJsonBody();
  $projectId = trim((string)($body['project_id'] ?? ''));
  $tasksInput = $body['tasks'] ?? [];

  if ($projectId === '') {
    sendError('project_id は必須です', 400);
  }
  if (!is_array($tasksInput) || count($tasksInput) === 0) {
    sendError('tasks は1件以上の配列で指定してください', 400);
  }
  if (count($tasksInput) > 500) {
    // 誤操作・異常データによる暴走防止（4週分×グループメンバー全員分でも通常この上限には達しない想定）
    sendError('一度にインポートできるタスクは500件までです', 400);
  }

  if (!canAccessProject($db, $userId, $userRole, $projectId)) {
    sendError('このプロジェクトにアクセスする権限がありません', 403);
  }

  // タスク入力の検証・正規化
  // 各要素: { taskName: string, startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD', assignee?: string }
  $normalizedTasks = [];
  foreach ($tasksInput as $t) {
    $taskName = trim((string)($t['taskName'] ?? ''));
    $startDate = (string)($t['startDate'] ?? '');
    $endDate = (string)($t['endDate'] ?? '');
    $assignee = trim((string)($t['assignee'] ?? ''));

    if ($taskName === '') continue; // 空タスク名はスキップ
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDate) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate)) {
      continue; // 日付不正はスキップ（サーバー側の防御的検証。拡張機能側では正しい形式で送る想定）
    }

    $normalizedTasks[] = [
      'taskName'  => $taskName,
      'startDate' => $startDate,
      'endDate'   => $endDate,
      'assignee'  => $assignee,
    ];
  }

  if (count($normalizedTasks) === 0) {
    sendError('有効なタスクがありませんでした', 400);
  }

  // サーバー側でも表示名一致による assignee 正規化の二重チェックを行う
  // （設計書10.3節: 拡張機能側実装ミスや送信までの間のメンバー変更ズレを防止するため）
  $members = getProjectMembers($db, $projectId);
  foreach ($normalizedTasks as &$t) {
    if ($t['assignee'] === '') continue;
    foreach ($members as $m) {
      $displayName = (string)$m['displayName'];
      if ($displayName !== '' && mb_strpos($displayName, $t['assignee']) !== false) {
        $t['assignee'] = $displayName; // 正式なメンバー表示名に正規化
        break;
      }
      // 逆方向（intra-mart側の氏名の一部がメンバー名に含まれる場合等）も許容
      if ($displayName !== '' && mb_strpos($t['assignee'], $displayName) !== false) {
        $t['assignee'] = $displayName;
        break;
      }
    }
  }
  unset($t);

  // ─── トランザクション: SELECT ... FOR UPDATE → snapshot更新 → COMMIT ───
  $db->begin_transaction();
  try {
    $stmt = $db->prepare('SELECT snapshot, version FROM projects WHERE project_id = ? FOR UPDATE');
    $stmt->bind_param('s', $projectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();

    if (!$row) {
      $db->rollback();
      sendError('プロジェクトが見つかりません: ' . $projectId, 404);
    }

    $snapshot = $row['snapshot'] ? json_decode($row['snapshot'], true) : null;
    if (!is_array($snapshot)) {
      $db->rollback();
      sendError('このプロジェクトにはまだガントチャートデータが作成されていません。先に一度ブラウザでプロジェクトを開いてください', 400);
    }

    if (!isset($snapshot['rows']) || !is_array($snapshot['rows'])) $snapshot['rows'] = [];
    if (!isset($snapshot['tasks']) || !is_array($snapshot['tasks'])) $snapshot['tasks'] = [];

    $newRows = [];
    $newTasks = [];
    foreach ($normalizedTasks as $t) {
      $rowId = 'row-' . bin2hex(random_bytes(6));
      $taskId = 'task-' . bin2hex(random_bytes(6));
      $newRows[] = [
        'id'        => $rowId,
        'name'      => $t['taskName'],
        'level'     => 0,
        'parentId'  => null,
        'collapsed' => false,
      ];
      $newTasks[] = [
        'id'             => $taskId,
        'rowId'          => $rowId,
        'name'           => $t['taskName'],
        'start'          => $t['startDate'],
        'end'            => $t['endDate'],
        'color'          => '',
        'textColor'      => '',
        'content'        => '',
        'memo'           => '',
        'assignee'       => $t['assignee'],
        'assigneeUserId' => null,
        'locked'         => false,
        'anchored'       => false,
        'status'         => 'not_started',
        'actualStart'    => null,
        'actualEnd'      => null,
      ];
    }

    // 設計書10.2節相当（Teams Excel連携・Google/Office版と同一方針）: 現在の
    // プロジェクトの最上位（第0階層）末尾にフラットな単一タスクとして追加
    $snapshot['rows'] = array_merge($snapshot['rows'], $newRows);
    $snapshot['tasks'] = array_merge($snapshot['tasks'], $newTasks);

    $newVersion = (int)$row['version'] + 1;
    $snapshotJson = json_encode($snapshot, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    $upd = $db->prepare('UPDATE projects SET snapshot = ?, version = ? WHERE project_id = ?');
    $upd->bind_param('sis', $snapshotJson, $newVersion, $projectId);
    $upd->execute();

    // operation_logs への追記（Teams Excel連携と同様、記録失敗は本処理の成否に影響させない）
    $opPayload = json_encode(['source' => 'groupware_schedule_import', 'taskCount' => count($newTasks)], JSON_UNESCAPED_UNICODE);
    $logStmt = $db->prepare(
      'INSERT INTO operation_logs (project_id, op_type, op_payload, version, user_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?)'
    );
    $opType = 'groupware_schedule_import';
    $sessionIdForLog = 'ext-token-user-' . $userId; // 拡張機能経由のためsessionsテーブルのIDは存在しない
    $logStmt->bind_param('sssiis', $projectId, $opType, $opPayload, $newVersion, $userId, $sessionIdForLog);
    @$logStmt->execute(); // operation_logsへの記録失敗は本処理の成否に影響させない

    $db->commit();
  } catch (\Throwable $e) {
    $db->rollback();
    error_log('[groupware_schedule_import.php] import_tasks 失敗: ' . $e->getMessage());
    sendError('タスクの追加に失敗しました。しばらくしてから再度お試しください', 500);
  }

  // 設計書3節の方針（Teams Excel連携で2026-08-19に後追い対応した不具合を、
  // 本機能では初版から防止する）: 拡張機能がDBのsnapshotを直接書き換えた直後、
  // gantt-ws（WebSocketサーバー）へ「このプロジェクトを開いているクライアントが
  // いれば最新化して」と通知する。これを行わないと、ガントチャート画面を開いた
  // ままの状態から後でリロード/切断した際に、gantt-wsがメモリ上に保持していた
  // 「インポート前の古いsnapshot」でDBが再度上書きされ、インポートしたタスクが
  // 消えてしまう事故が発生する。gantt-ws側にroomが存在しない（誰も開いていない）
  // 場合は何もされない（DBは既に正しい状態のため実害はない）。失敗しても本処理の
  // 成否には影響させない。
  _pushGanttFullSyncToWs($projectId, $snapshot, $newVersion);

  sendJson(['ok' => true, 'importedCount' => count($newTasks)]);
}

// ─── 未対応 ────────────────────────────────────────────
sendError('未対応のアクション: ' . $action, 404);
