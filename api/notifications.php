<?php
// Phase 5-7: 致命的エラーをJSONで返すシャットダウンハンドラ
register_shutdown_function(function () {
  $err = error_get_last();
  if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
    if (!headers_sent()) {
      http_response_code(500);
      header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode(['ok' => false, 'error' => 'PHP Fatal: ' . $err['message'] . ' @ ' . basename($err['file']) . ':' . $err['line']], JSON_UNESCAPED_UNICODE);
  }
});

/**
 * ガントチャート 通知API (Phase 5-1)
 * ===================================
 * GET  /api/notifications.php?project=XXX[&category=reminder|mention][&limit=N][&offset=N]
 *   → ログインユーザーの通知一覧を返す
 *
 * POST /api/notifications.php
 *   action=mark_read     : body { id: N } または { ids: [N,N,...] }  既読にする
 *   action=mark_all_read : body { project: "XXX" }  指定プロジェクトの全件既読
 *   action=create_assign : body { project_id, task_id, task_name, assignee_user_id, prev_assignee_user_id }
 *   action=create        : (管理者 or システム内部用) 新規通知作成
 *     body { user_id, project_id, category, type, title, body, ref_task_id, from_user_id }
 *
 * DELETE /api/notifications.php?id=N  : 削除（自分の通知のみ）
 *
 * WebSocket通知: POST action=push_ws で接続中ユーザーへリアルタイム通知
 *   ※ server.js が DB ポーリングまたは本APIコール後に push する想定
 */

require_once __DIR__ . '/config.php';

handlePreflight();
$user = requireAuth();

$db     = getDb();
$method = $_SERVER['REQUEST_METHOD'];

// ──────────────────────────────────────────
// GET: プロジェクト通知設定取得 (Phase 5-5)
//    ※ 一般GETハンドラの前に配置（sendJsonがexitするため）
// ──────────────────────────────────────────
if ($method === 'GET' && ($_GET['action'] ?? '') === 'get_notification_settings') {
  $projectId = $_GET['project'] ?? '';
  if ($projectId === '') sendError('project パラメータが必要です', 400);

  // アクセス権チェック
  if (!canAccessProject($db, $user['id'], $user['role'], $projectId)) {
    sendError('このプロジェクトにアクセスする権限がありません', 403);
  }

  $stmt = $db->prepare(
    'SELECT email_alert_enabled, notify_delay_alert, notify_task_assign, notify_mention, notify_advance_days, notify_start_advance_days, notify_end_advance_enabled, notify_start_advance_enabled, notify_assignee_only, updated_at
     FROM project_notification_settings WHERE project_id = ?'
  );
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  $stmt->close();

  if (!$row) {
    sendJson([
      'ok'       => true,
      'settings' => [
        'email_alert_enabled'      => 0,
        'notify_delay_alert'       => 1,
        'notify_task_assign'       => 1,
        'notify_mention'           => 1,
        'notify_advance_days'      => 3,
        'notify_start_advance_days'=> 3,
        'notify_end_advance_enabled'   => 1,
        'notify_start_advance_enabled' => 1,
        'notify_assignee_only'         => 1,
        'updated_at'               => null,
        'exists'                   => false,
      ],
    ]);
  }

  sendJson([
    'ok'       => true,
    'settings' => [
      'email_alert_enabled'      => (int)$row['email_alert_enabled'],
      'notify_delay_alert'       => (int)$row['notify_delay_alert'],
      'notify_task_assign'       => (int)$row['notify_task_assign'],
      'notify_mention'           => (int)$row['notify_mention'],
      'notify_advance_days'      => (int)$row['notify_advance_days'],
      'notify_start_advance_days'=> (int)$row['notify_start_advance_days'],
      'notify_end_advance_enabled'   => (int)$row['notify_end_advance_enabled'],
      'notify_start_advance_enabled' => (int)$row['notify_start_advance_enabled'],
      'notify_assignee_only'         => (int)$row['notify_assignee_only'],
      'updated_at'               => $row['updated_at'],
      'exists'                   => true,
    ],
  ]);
}

// ──────────────────────────────────────────
// GET: 通知一覧取得
// ──────────────────────────────────────────
if ($method === 'GET') {
  $project  = $_GET['project']  ?? '';
  $category = $_GET['category'] ?? '';   // '' = 全カテゴリ
  $limit    = min((int)($_GET['limit']  ?? 50), 200);
  $offset   = max((int)($_GET['offset'] ?? 0), 0);
  $unread_only = isset($_GET['unread_only']) && $_GET['unread_only'] === '1';

  $where  = ['n.user_id = ?'];
  $params = [$user['id']];
  $types  = 'i';

  if ($project !== '') {
    // Phase 5-7: project_id が空の通知（全ユーザー向けアナウンス）も含めて取得
    $where[]  = '(n.project_id = ? OR n.project_id = \'\')';
    $params[] = $project;
    $types   .= 's';
  }
  if ($category !== '' && in_array($category, ['reminder', 'mention', 'announcement'], true)) {
    $where[]  = 'n.category = ?';
    $params[] = $category;
    $types   .= 's';
  }
  if ($unread_only) {
    $where[] = 'n.is_read = 0';
  }

  $whereStr = implode(' AND ', $where);

  // 総件数
  $stmtCount = $db->prepare("SELECT COUNT(*) FROM notifications n WHERE $whereStr");
  $stmtCount->bind_param($types, ...$params);
  $stmtCount->execute();
  $stmtCount->bind_result($total);
  $stmtCount->fetch();
  $stmtCount->close();

  // 未読件数
  $stmtUnread = $db->prepare("SELECT COUNT(*) FROM notifications n WHERE n.user_id = ? AND n.is_read = 0");
  $stmtUnread->bind_param('i', $user['id']);
  $stmtUnread->execute();
  $stmtUnread->bind_result($unread_count);
  $stmtUnread->fetch();
  $stmtUnread->close();

  // 一覧
  $sql = "
    SELECT
      n.id, n.project_id, n.category, n.type, n.title, n.body,
      n.ref_task_id, n.from_user_id, n.is_read,
      n.created_at,
      u.display_name AS from_display_name,
      u.username     AS from_username
    FROM notifications n
    LEFT JOIN users u ON u.id = n.from_user_id
    WHERE $whereStr
    ORDER BY n.created_at DESC
    LIMIT ? OFFSET ?
  ";
  $stmtList = $db->prepare($sql);
  $limitVal  = $limit;
  $offsetVal = $offset;
  $stmtList->bind_param($types . 'ii', ...[...$params, $limitVal, $offsetVal]);
  $stmtList->execute();
  $result = $stmtList->get_result();

  $notifications = [];
  while ($row = $result->fetch_assoc()) {
    $notifications[] = [
      'id'                => (int)$row['id'],
      'project_id'        => $row['project_id'],
      'category'          => $row['category'],
      'type'              => $row['type'],
      'title'             => $row['title'],
      'body'              => $row['body'],
      'ref_task_id'       => $row['ref_task_id'],
      'from_user_id'      => $row['from_user_id'] ? (int)$row['from_user_id'] : null,
      'from_display_name' => $row['from_display_name'] ?? null,
      'from_username'     => $row['from_username'] ?? null,
      'is_read'           => (bool)$row['is_read'],
      'created_at'        => $row['created_at'],
    ];
  }
  $stmtList->close();

  sendJson([
    'ok'            => true,
    'notifications' => $notifications,
    'total'         => $total,
    'unread_count'  => $unread_count,
    'limit'         => $limit,
    'offset'        => $offset,
  ]);
}


// ──────────────────────────────────────────
// DELETE: 通知削除
// ──────────────────────────────────────────
if ($method === 'DELETE') {
  $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
  if (!$id) sendError('IDが必要です', 400);

  $stmt = $db->prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?');
  $stmt->bind_param('ii', $id, $user['id']);
  $stmt->execute();
  if ($stmt->affected_rows === 0) sendError('通知が見つからないか権限がありません', 404);
  $stmt->close();
  sendJson(['ok' => true]);
}

// ──────────────────────────────────────────
// POST: 各アクション
// ──────────────────────────────────────────
if ($method === 'POST') {
  $body   = getJsonBody();
  $action = $body['action'] ?? '';

  // --- 既読: 単件 or 複数 ---
  if ($action === 'mark_read') {
    if (isset($body['ids']) && is_array($body['ids'])) {
      $ids = array_map('intval', $body['ids']);
      if (empty($ids)) sendJson(['ok' => true, 'updated' => 0]);
      $placeholders = implode(',', array_fill(0, count($ids), '?'));
      $types = str_repeat('i', count($ids));
      $stmt = $db->prepare("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id IN ($placeholders)");
      $bindParams = [$user['id'], ...$ids];
      $stmt->bind_param('i' . $types, ...$bindParams);
      $stmt->execute();
      $updated = $stmt->affected_rows;
      $stmt->close();
      sendJson(['ok' => true, 'updated' => $updated]);
    }
    $id = isset($body['id']) ? (int)$body['id'] : 0;
    if (!$id) sendError('idまたはidsが必要です', 400);
    $stmt = $db->prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?');
    $stmt->bind_param('ii', $id, $user['id']);
    $stmt->execute();
    $stmt->close();
    sendJson(['ok' => true]);
  }

  // --- 全件既読 ---
  if ($action === 'mark_all_read') {
    $project  = $body['project'] ?? '';
    $category = $body['category'] ?? '';
    $where  = ['user_id = ?'];
    $params = [$user['id']];
    $types  = 'i';
    if ($project !== '') { $where[] = 'project_id = ?'; $params[] = $project; $types .= 's'; }
    if ($category !== '' && in_array($category, ['reminder','mention','announcement'], true)) {
      $where[] = 'category = ?'; $params[] = $category; $types .= 's';
    }
    $whereStr = implode(' AND ', $where);
    $stmt = $db->prepare("UPDATE notifications SET is_read = 1 WHERE $whereStr AND is_read = 0");
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $updated = $stmt->affected_rows;
    $stmt->close();
    sendJson(['ok' => true, 'updated' => $updated]);
  }

  // --- 担当変更通知の自動生成 (Phase 5-2) ---
  if ($action === 'create_assign') {
    $projectId = trim((string)($body['project_id'] ?? ''));
    $taskId    = trim((string)($body['task_id'] ?? ''));
    $taskName  = trim((string)($body['task_name'] ?? 'タスク'));

    // 複数担当対応: 配列または単一値を受け取る
    $nextUserIds = [];
    if (isset($body['assignee_user_ids']) && is_array($body['assignee_user_ids'])) {
      $nextUserIds = array_values(array_filter(array_map('intval', $body['assignee_user_ids']), fn($v) => $v > 0));
    } elseif (isset($body['assignee_user_id']) && $body['assignee_user_id'] !== null) {
      $nextUserIds = [(int)$body['assignee_user_id']];
    }

    $prevUserIds = [];
    if (isset($body['prev_assignee_user_ids']) && is_array($body['prev_assignee_user_ids'])) {
      $prevUserIds = array_values(array_filter(array_map('intval', $body['prev_assignee_user_ids']), fn($v) => $v > 0));
    } elseif (isset($body['prev_assignee_user_id']) && $body['prev_assignee_user_id'] !== null) {
      $prevUserIds = [(int)$body['prev_assignee_user_id']];
    }

    $actorUserId = (int)($user['id'] ?? 0);
    $actorRole   = (string)($user['role'] ?? 'user');
    $actorName   = trim((string)($user['displayName'] ?? $user['display_name'] ?? $user['username'] ?? 'ユーザー'));

    if ($projectId === '') sendError('project_idが必要です', 400);
    if (!canAccessProject($db, $actorUserId, $actorRole, $projectId)) {
      sendError('このプロジェクトにアクセスする権限がありません', 403);
    }

    // Phase 5-6: プロジェクト通知設定チェック
    $notifSettings = _getNotifSettings($db, $projectId);
    if (!$notifSettings['notify_task_assign']) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => [], 'skipped' => 'notify_task_assign_disabled']);
    }

    // 差分を計算
    $added   = array_values(array_diff($nextUserIds, $prevUserIds));
    $removed = array_values(array_diff($prevUserIds, $nextUserIds));
    if (empty($added) && empty($removed)) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => []]);
    }

    $created = [];

    // 新規担当者へ通知（操作者が自分自身を担当に設定した場合はスキップ）
    foreach ($added as $uid) {
      if ($uid === $actorUserId) continue; // 自分への通知はスキップ
      if (_notificationTargetIsProjectMember($db, $projectId, $uid)) {
        $title = 'タスクの担当に設定されました';
        $bodyText = sprintf('「%s」の担当者に設定されました（設定者: %s）', $taskName, $actorName);
        $id = _createNotification($db, $uid, $projectId, 'mention', 'task_assign', $title, $bodyText, $taskId, $actorUserId);
        if ($id > 0) {
          $created[] = ['id' => $id, 'user_id' => $uid, 'type' => 'task_assign', 'title' => $title, 'body' => $bodyText, 'ref_task_id' => $taskId];
        }
      }
    }

    // 解除された担当者へ通知（自分が自分を外した場合はスキップ）
    foreach ($removed as $uid) {
      if ($uid === $actorUserId) continue; // 自分への通知はスキップ
      if (_notificationTargetIsProjectMember($db, $projectId, $uid)) {
        $title = 'タスクの担当から解除されました';
        $bodyText = sprintf('「%s」の担当から解除されました（解除者: %s）', $taskName, $actorName);
        $id = _createNotification($db, $uid, $projectId, 'mention', 'task_unassign', $title, $bodyText, $taskId, $actorUserId);
        if ($id > 0) {
          $created[] = ['id' => $id, 'user_id' => $uid, 'type' => 'task_unassign', 'title' => $title, 'body' => $bodyText, 'ref_task_id' => $taskId];
        }
      }
    }

    // Phase 5-2: DB保存後、WebSocketサーバーへ通知プッシュ
    _pushNotificationToWs($created);

    sendJson([
      'ok' => true,
      'ids' => array_values(array_map(static fn($item) => (int)$item['id'], $created)),
      'created_notifications' => $created,
    ]);
  }

  // --- フェーズ5-3: 遅延アラート作成 ---

  // ================================================================
  // Phase 5-4: @メンション通知作成
  // ================================================================
  if ($action === 'create_mention') {
    // $body は POST処理ブロック冒頭で読み込み済み（再読み不要）
    $projectId         = trim((string)($body['project_id']        ?? ''));
    $taskId            = trim((string)($body['task_id']           ?? ''));
    $taskName          = trim((string)($body['task_name']         ?? 'タスク'));
    $fromUserId        = (int)($body['from_user_id']              ?? 0);
    $mentionedUserIds  = isset($body['mentioned_user_ids']) && is_array($body['mentioned_user_ids'])
      ? array_values(array_filter(array_map('intval', $body['mentioned_user_ids']), fn($v) => $v > 0))
      : [];

    if ($projectId === '')   sendError('project_idが必要です', 400);
    if ($taskId === '')      sendError('task_idが必要です', 400);
    if (empty($mentionedUserIds)) sendJson(['ok' => true, 'ids' => [], 'created_notifications' => []]);

    if (!canAccessProject($db, $user['id'], $user['role'], $projectId)) {
      sendError('このプロジェクトにアクセスする権限がありません', 403);
    }

    // Phase 5-6: プロジェクト通知設定チェック
    $notifSettings = _getNotifSettings($db, $projectId);
    if (!$notifSettings['notify_mention']) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => [], 'skipped' => 'notify_mention_disabled']);
    }

    $todayStr      = (new DateTime('today', new DateTimeZone('Asia/Tokyo')))->format('Y-m-d');
    $created       = [];
    $actorName     = $user['displayName'] ?? $user['username'] ?? 'ユーザー';
    $mentionMessage = trim((string)($body['mention_message'] ?? ''));

    foreach ($mentionedUserIds as $uid) {
      // 注: 自分自身へのメンションも通知を作成する

      // 当日に同じ送信者から同じタスクへのメンション通知が既に存在する場合はスキップ
      $checkStmt = $db->prepare(
        "SELECT id FROM notifications
         WHERE user_id = ? AND project_id = ? AND type = 'mention'
           AND ref_task_id = ? AND from_user_id = ? AND DATE(created_at) = ?
         LIMIT 1"
      );
      $checkStmt->bind_param('issss', $uid, $projectId, $taskId, $fromUserId, $todayStr);
      $checkStmt->execute();
      $checkResult = $checkStmt->get_result();
      if ($checkResult->num_rows > 0) {
        $checkStmt->close();
        continue; // 重複スキップ
      }
      $checkStmt->close();

      // タイトル: 「{actorName}さんからメンション」
      $title    = sprintf('%s さんからメンション', $actorName);
      // 本文: メモ/内容テキストがあればそのまま表示、なければタスク名を添える
      $bodyText = $mentionMessage !== ''
        ? $mentionMessage
        : sprintf('「%s」でメンションされました', $taskName);
      $id = _createNotification($db, $uid, $projectId, 'mention', 'mention', $title, $bodyText, $taskId, $fromUserId ?: null);
      if ($id > 0) {
        $created[] = [
          'id'          => $id,
          'user_id'     => $uid,
          'type'        => 'mention',
          'title'       => $title,
          'body'        => $bodyText,
          'ref_task_id' => $taskId,
          'from_user_id'=> $fromUserId ?: null,
        ];
      }
    }

    if (!empty($created)) {
      _pushNotificationToWs($created);
    }

    sendJson([
      'ok'                   => true,
      'ids'                  => array_values(array_map(static fn($item) => (int)$item['id'], $created)),
      'created_notifications'=> $created,
    ]);
  }

  if ($action === 'create_delay_alert') {
    // $body は POST処理ブロック冒頭で読み込み済み（再読み不要）
    $projectId   = trim((string)($body['project_id'] ?? ''));
    $delayedTasks = $body['delayed_tasks'] ?? [];

    if ($projectId === '') sendError('project_idが必要です', 400);
    if (!canAccessProject($db, $user['id'], $user['role'], $projectId)) {
      sendError('このプロジェクトにアクセスする権限がありません', 403);
    }
    if (!is_array($delayedTasks) || count($delayedTasks) === 0) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => []]);
    }

    // Phase 5-6: プロジェクト通知設定チェック
    $notifSettings = _getNotifSettings($db, $projectId);
    if (!$notifSettings['notify_delay_alert']) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => [], 'skipped' => 'notify_delay_alert_disabled']);
    }

    $todayStr = (new DateTime('today', new DateTimeZone('Asia/Tokyo')))->format('Y-m-d');
    $created  = [];

    // ── 送信されてきた遅延タスクIDの一覧を収集 ──────────────────
    // このプロジェクトで「現在も遅延中」のtask_idセット。
    // DBに残っている削除済みタスクの delay_alert 通知はここに含まれないので
    // 後でまとめて削除する。
    $activeDelayTaskIds = [];
    foreach ($delayedTasks as $dt) {
      $tid = trim((string)($dt['task_id'] ?? ''));
      if ($tid !== '') $activeDelayTaskIds[] = $tid;
    }

    // ── 削除済みタスクの delay_alert 通知を掃除 ─────────────────
    // project_id が一致し、ref_task_id が activeDelayTaskIds に含まれない
    // delay_alert 通知をすべて削除する（ユーザー限定なし＝プロジェクト全員分）。
    if (!empty($activeDelayTaskIds)) {
      $placeholders = implode(',', array_fill(0, count($activeDelayTaskIds), '?'));
      $cleanTypes   = 's' . str_repeat('s', count($activeDelayTaskIds));
      $cleanStmt    = $db->prepare(
        "DELETE FROM notifications
          WHERE project_id = ? AND type = 'delay_alert'
            AND ref_task_id NOT IN ($placeholders)"
      );
      $cleanStmt->bind_param($cleanTypes, $projectId, ...$activeDelayTaskIds);
      $cleanStmt->execute();
      $cleanStmt->close();
    } else {
      // 遅延タスクが0件のはずだが念のため：プロジェクトの全delay_alert通知を削除
      $cleanStmt = $db->prepare(
        "DELETE FROM notifications WHERE project_id = ? AND type = 'delay_alert'"
      );
      $cleanStmt->bind_param('s', $projectId);
      $cleanStmt->execute();
      $cleanStmt->close();
    }

    foreach ($delayedTasks as $dt) {
      $taskId   = trim((string)($dt['task_id']   ?? ''));
      $taskName = trim((string)($dt['task_name'] ?? 'タスク'));
      $taskEnd  = trim((string)($dt['end']       ?? ''));
      $assigneeUserIds = isset($dt['assignee_user_ids']) && is_array($dt['assignee_user_ids'])
        ? array_values(array_filter(array_map('intval', $dt['assignee_user_ids']), fn($v) => $v > 0))
        : [];

      if ($taskId === '') continue;

      // 担当者がいない場合は自分（ログイン中ユーザー）に通知
      $targets = !empty($assigneeUserIds) ? $assigneeUserIds : [(int)$user['id']];

      // Phase 5-6: オーバー日数を計算（ループ外で1回だけ実行）
      $todayDt    = new DateTime('today', new DateTimeZone('Asia/Tokyo'));
      // Y-m-d 形式も Y/m/d 形式も対応してパース
      $endDt = false;
      if ($taskEnd !== '') {
        $endDt = DateTime::createFromFormat('Y-m-d', $taskEnd, new DateTimeZone('Asia/Tokyo'));
        if (!$endDt) {
          $endDt = DateTime::createFromFormat('Y/m/d', $taskEnd, new DateTimeZone('Asia/Tokyo'));
        }
        if ($endDt) {
          // 時刻をリセット（比較を日付ベースにする）
          $endDt->setTime(0, 0, 0);
        }
      }
      $overdueDays = ($endDt && $endDt < $todayDt)
        ? (int)$todayDt->diff($endDt)->days
        : 0;
      // デバッグログ
      error_log(sprintf('[DelayAlert] taskId=%s taskEnd=%s endDt=%s todayDt=%s overdueDays=%d',
        $taskId, $taskEnd,
        ($endDt ? $endDt->format('Y-m-d') : 'false'),
        $todayDt->format('Y-m-d'),
        $overdueDays
      ));
      $title    = $overdueDays > 0
        ? sprintf('「%s」が遅延　[%d日オーバー]', $taskName, $overdueDays)
        : sprintf('「%s」が遅延', $taskName);
      $bodyText = '';

      foreach ($targets as $uid) {
        // 同タスク・同ユーザーの既存delay_alert通知を取得（日付問わず最新1件）
        // ※ DATE(created_at)=todayStr ではなく全期間で検索して確実にUPDATEする
        $checkStmt = $db->prepare(
          "SELECT id FROM notifications WHERE user_id = ? AND project_id = ? AND type = 'delay_alert'
           AND ref_task_id = ? ORDER BY created_at DESC LIMIT 1"
        );
        $checkStmt->bind_param('iss', $uid, $projectId, $taskId);
        $checkStmt->execute();
        $checkResult = $checkStmt->get_result();
        $existingRow = $checkResult->fetch_assoc();
        $checkStmt->close();

        if ($existingRow) {
          // 既存通知のタイトルを最新の日数で上書き（created_atも今日に更新）
          $upStmt = $db->prepare('UPDATE notifications SET title = ?, created_at = NOW() WHERE id = ?');
          $upStmt->bind_param('si', $title, $existingRow['id']);
          $upStmt->execute();
          $upStmt->close();
          // WebSocket用に追加
          $created[] = [
            'id'         => (int)$existingRow['id'],
            'user_id'    => $uid,
            'type'       => 'delay_alert',
            'title'      => $title,
            'body'       => $bodyText,
            'ref_task_id'=> $taskId,
          ];
          error_log(sprintf('[DelayAlert] Updated existing notification id=%d title=%s', $existingRow['id'], $title));
          continue;
        }

        $id = _createNotification($db, $uid, $projectId, 'reminder', 'delay_alert', $title, $bodyText, $taskId, null);
        if ($id > 0) {
          $created[] = [
            'id'         => $id,
            'user_id'    => $uid,
            'type'       => 'delay_alert',
            'title'      => $title,
            'body'       => $bodyText,
            'ref_task_id'=> $taskId,
          ];
        }
      }
    }

    // WebSocket でリアルタイムプッシュ
    if (!empty($created)) {
      _pushNotificationToWs($created);
    }

    sendJson([
      'ok'                   => true,
      'ids'                  => array_values(array_map(static fn($item) => (int)$item['id'], $created)),
      'created_notifications'=> $created,
    ]);
  }

  // --- 予定予告（備忘録）通知作成 (Phase 5-6) ---
  if ($action === 'create_advance_notice') {
    $projectId    = trim((string)($body['project_id'] ?? ''));
    $upcomingTasks = $body['upcoming_tasks'] ?? [];

    if ($projectId === '') sendError('project_idが必要です', 400);
    if (!canAccessProject($db, $user['id'], $user['role'], $projectId)) {
      sendError('このプロジェクトにアクセスする権限がありません', 403);
    }
    if (!is_array($upcomingTasks) || count($upcomingTasks) === 0) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => []]);
    }

    // Phase 5-6: プロジェクト通知設定チェック
    $notifSettings = _getNotifSettings($db, $projectId);
    $advanceDays         = (int)($notifSettings['notify_advance_days'] ?? 3);
    $startAdvanceDays    = (int)($notifSettings['notify_start_advance_days'] ?? 3);
    $endAdvEnabled       = (int)($notifSettings['notify_end_advance_enabled'] ?? 1);
    $startAdvEnabled     = (int)($notifSettings['notify_start_advance_enabled'] ?? 1);
    $assigneeOnly        = (int)($notifSettings['notify_assignee_only'] ?? 1);
    // 両方とも無効、または両方とも0日の場合は全体スキップ
    $endAdvActive   = ($endAdvEnabled === 1   && $advanceDays > 0);
    $startAdvActive = ($startAdvEnabled === 1 && $startAdvanceDays > 0);
    if (!$endAdvActive && !$startAdvActive) {
      sendJson(['ok' => true, 'ids' => [], 'created_notifications' => [], 'skipped' => 'advance_notice_disabled']);
    }

    $todayStr = (new DateTime('today', new DateTimeZone('Asia/Tokyo')))->format('Y-m-d');
    $created  = [];

    foreach ($upcomingTasks as $ut) {
      $taskId   = trim((string)($ut['task_id']   ?? ''));
      $taskName = trim((string)($ut['task_name'] ?? 'タスク'));
      $taskEnd  = trim((string)($ut['end']       ?? ''));
      $taskStart= trim((string)($ut['start']     ?? ''));
      $daysUntil = (int)($ut['days_until'] ?? 0);
      $startDaysUntil = (int)($ut['start_days_until'] ?? -1);  // -1 = 開始日情報なし
      $taskStatus = trim((string)($ut['status'] ?? 'not_started'));
      $assigneeUserIds = isset($ut['assignee_user_ids']) && is_array($ut['assignee_user_ids'])
        ? array_values(array_filter(array_map('intval', $ut['assignee_user_ids']), fn($v) => $v > 0))
        : [];

      if ($taskId === '') continue;

      // Phase 5-6: notify_assignee_only の判定
      //   ON  (1): 担当者のみ通知、担当者不在時はスキップ
      //   OFF (0): プロジェクト全メンバーに通知
      if ($assigneeOnly === 1) {
        $targets = $assigneeUserIds;  // 担当者のみ
      } else {
        // プロジェクトの全メンバーに通知
        $allMembers = getProjectMembers($db, $projectId);
        $targets = [];
        foreach ($allMembers as $member) {
          $memberUserId = (int)($member['user_id'] ?? 0);
          if ($memberUserId > 0) $targets[] = $memberUserId;
        }
      }
      if (empty($targets)) continue;  // 通知対象がいない場合はスキップ

      // --- 終了予告 ---
      if ($endAdvActive && $daysUntil <= $advanceDays) {
        foreach ($targets as $uid) {
          // 当日分が既に存在する場合はスキップ（重複防止）
          $checkStmt = $db->prepare(
            "SELECT id FROM notifications WHERE user_id = ? AND project_id = ? AND type = 'advance_notice'
             AND ref_task_id = ? AND DATE(created_at) = ? LIMIT 1"
          );
          $checkStmt->bind_param('isss', $uid, $projectId, $taskId, $todayStr);
          $checkStmt->execute();
          $checkResult = $checkStmt->get_result();
          if ($checkResult->num_rows > 0) {
            $checkStmt->close();
            continue;
          }
          $checkStmt->close();

          // Phase 5-6 fix: 今日を含めたカウント（例: 終了日が翌日→「あと2日」）
          $displayDays = $daysUntil + 1;
          $title    = $daysUntil > 0
            ? sprintf('「%s」　[あと%d日]', $taskName, $displayDays)
            : sprintf('「%s」　[今日]', $taskName);
          $bodyText = '';  // Phase 5-6: タイトルのみで情報十分、本文は空
          $id = _createNotification($db, $uid, $projectId, 'reminder', 'advance_notice', $title, $bodyText, $taskId, null);
          if ($id > 0) {
            $created[] = [
              'id'         => $id,
              'user_id'    => $uid,
              'type'       => 'advance_notice',
              'title'      => $title,
              'body'       => $bodyText,
              'ref_task_id'=> $taskId,
            ];
          }
        }
      }

      // --- 開始予告 (not_startedのみ対象) ---
      if ($startAdvActive && $startDaysUntil >= 0 && $startDaysUntil <= $startAdvanceDays && $taskStatus === 'not_started') {
        foreach ($targets as $uid) {
          // 当日分が既に存在する場合はスキップ（重複防止）
          $checkStmt = $db->prepare(
            "SELECT id FROM notifications WHERE user_id = ? AND project_id = ? AND type = 'start_advance_notice'
             AND ref_task_id = ? AND DATE(created_at) = ? LIMIT 1"
          );
          $checkStmt->bind_param('isss', $uid, $projectId, $taskId, $todayStr);
          $checkStmt->execute();
          $checkResult = $checkStmt->get_result();
          if ($checkResult->num_rows > 0) {
            $checkStmt->close();
            continue;
          }
          $checkStmt->close();

          // Phase 5-6: 開始予告は日数差をそのまま使用（終了予告と違い+1不要）
          $displayDays = $startDaysUntil;
          $title    = $startDaysUntil > 0
            ? sprintf('「%s」　[あと%d日]', $taskName, $displayDays)
            : sprintf('「%s」　[今日]', $taskName);
          $bodyText = '';
          $id = _createNotification($db, $uid, $projectId, 'reminder', 'start_advance_notice', $title, $bodyText, $taskId, null);
          if ($id > 0) {
            $created[] = [
              'id'         => $id,
              'user_id'    => $uid,
              'type'       => 'start_advance_notice',
              'title'      => $title,
              'body'       => $bodyText,
              'ref_task_id'=> $taskId,
            ];
          }
        }
      }
    }

    // WebSocket でリアルタイムプッシュ
    if (!empty($created)) {
      _pushNotificationToWs($created);
    }

    sendJson([
      'ok'                   => true,
      'ids'                  => array_values(array_map(static fn($item) => (int)$item['id'], $created)),
      'created_notifications'=> $created,
    ]);
  }

  // --- 新規作成 (管理者 or 内部API) ---
  if ($action === 'create') {
    // 管理者またはシステム内部(server-to-server)のみ許可
    if ($user['role'] !== 'admin') sendError('管理者権限が必要です', 403);

    $targetUserId = isset($body['user_id']) ? (int)$body['user_id'] : 0;
    $projectId    = $body['project_id']    ?? '';
    $category     = $body['category']      ?? '';
    $type         = $body['type']          ?? '';
    $title        = trim($body['title']    ?? '');
    $notifBody    = $body['body']          ?? '';
    $refTaskId    = $body['ref_task_id']   ?? '';
    $fromUserId   = isset($body['from_user_id']) ? (int)$body['from_user_id'] : null;

    if (!$targetUserId) sendError('user_idが必要です', 400);
    if (!in_array($category, ['reminder','mention','announcement'], true)) sendError('categoryが不正です', 400);
    if ($title === '') sendError('titleが必要です', 400);

    $notifId = _createNotification($db, $targetUserId, $projectId, $category, $type, $title, $notifBody, $refTaskId, $fromUserId);
    sendJson(['ok' => true, 'id' => $notifId]);
  }

  // --- 一括作成 (管理者) ---
  if ($action === 'create_bulk') {
    if ($user['role'] !== 'admin') sendError('管理者権限が必要です', 403);
    $items = $body['items'] ?? [];
    if (!is_array($items) || empty($items)) sendError('itemsが必要です', 400);
    $created = [];
    foreach ($items as $item) {
      $id = _createNotification(
        $db,
        (int)($item['user_id']    ?? 0),
        $item['project_id']       ?? '',
        $item['category']         ?? 'mention',
        $item['type']             ?? '',
        trim($item['title']       ?? ''),
        $item['body']             ?? '',
        $item['ref_task_id']      ?? '',
        isset($item['from_user_id']) ? (int)$item['from_user_id'] : null
      );
      $created[] = $id;
    }
    sendJson(['ok' => true, 'ids' => $created]);
  }

  // --- アナウンス一斉送信 (Phase 5-7) ---
  if ($action === 'create_announcement') {
    if ($user['role'] !== 'admin') sendError('管理者権限が必要です', 403);

    $target    = $body['target']     ?? 'all';   // 'all' or 'project'
    $projectId = $body['project_id'] ?? '';
    $title     = trim($body['title'] ?? '');
    $notifBody = trim($body['body']  ?? '');
    $fromUserId = (int)$user['id'];

    if ($title === '') sendError('titleが必要です', 400);
    if ($target === 'project' && $projectId === '') sendError('project_idが必要です', 400);

    // 送信先ユーザーID一覧を取得
    $targetUserIds = [];
    if ($target === 'all') {
      // 全ユーザー
      $stmt = $db->prepare('SELECT id FROM users ORDER BY id');
      $stmt->execute();
      $res = $stmt->get_result();
      while ($row = $res->fetch_assoc()) {
        $targetUserIds[] = (int)$row['id'];
      }
      $stmt->close();
    } else {
      // 特定PJのメンバー
      $stmt = $db->prepare('SELECT user_id FROM project_members WHERE project_id = ? ORDER BY user_id');
      $stmt->bind_param('s', $projectId);
      $stmt->execute();
      $res = $stmt->get_result();
      while ($row = $res->fetch_assoc()) {
        $targetUserIds[] = (int)$row['user_id'];
      }
      $stmt->close();
    }

    if (empty($targetUserIds)) sendError('送信先ユーザーが見つかりません', 404);

    // 通知レコードを生成
    $created = [];
    $wsPushItems = [];
    foreach ($targetUserIds as $uid) {
      // 自分自身への送信もスキップしない（管理者自身にも届ける）
      $pid = ($target === 'project') ? $projectId : '';
      $notifId = _createNotification(
        $db, $uid, $pid, 'announcement', 'announcement',
        $title, $notifBody, '', $fromUserId
      );
      $created[] = $notifId;
      $wsPushItems[] = [
        'id'          => $notifId,
        'user_id'     => $uid,
        'type'        => 'announcement',
        'title'       => $title,
        'body'        => $notifBody,
        'ref_task_id' => '',
        'category'    => 'announcement',
      ];
    }

    // WebSocket経由でリアルタイムプッシュ
    _pushNotificationToWs($wsPushItems);

    sendJson(['ok' => true, 'sent_count' => count($created)]);
  }


  // --- プロジェクト通知設定更新 (Phase 5-5) ---
  if ($action === 'update_notification_settings') {
    $projectId = $body['project_id'] ?? '';
    if ($projectId === '') sendError('project_id が必要です', 400);

    // PJ管理権限チェック（引数順序に注意: $db, userId, role, projectId）
    if (!isProjectManager($db, (int)$user['id'], $user['role'], $projectId)) {
      sendError('PJ管理権限が必要です', 403);
    }

    $emailAlert   = isset($body['email_alert_enabled']) ? (int)(bool)$body['email_alert_enabled'] : 0;
    $notifyDelay  = isset($body['notify_delay_alert'])  ? (int)(bool)$body['notify_delay_alert']  : 1;
    $notifyAssign = isset($body['notify_task_assign'])  ? (int)(bool)$body['notify_task_assign']  : 1;
    $notifyMention= isset($body['notify_mention'])      ? (int)(bool)$body['notify_mention']      : 1;
    $notifyAdvanceDays     = isset($body['notify_advance_days']) ? max(0, min(30, (int)$body['notify_advance_days'])) : 3;
    $notifyStartAdvanceDays= isset($body['notify_start_advance_days']) ? max(0, min(30, (int)$body['notify_start_advance_days'])) : 3;
    $notifyEndAdvEnabled   = isset($body['notify_end_advance_enabled'])   ? (int)(bool)$body['notify_end_advance_enabled']   : 1;
    $notifyStartAdvEnabled = isset($body['notify_start_advance_enabled']) ? (int)(bool)$body['notify_start_advance_enabled'] : 1;
    $notifyAssigneeOnly    = isset($body['notify_assignee_only'])         ? (int)(bool)$body['notify_assignee_only']         : 1;
    $updatedBy    = (int)$user['id'];

    // UPSERT
    $stmt = $db->prepare('
      INSERT INTO project_notification_settings
        (project_id, email_alert_enabled, notify_delay_alert, notify_task_assign, notify_mention, notify_advance_days, notify_start_advance_days, notify_end_advance_enabled, notify_start_advance_enabled, notify_assignee_only, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        email_alert_enabled         = VALUES(email_alert_enabled),
        notify_delay_alert          = VALUES(notify_delay_alert),
        notify_task_assign          = VALUES(notify_task_assign),
        notify_mention              = VALUES(notify_mention),
        notify_advance_days         = VALUES(notify_advance_days),
        notify_start_advance_days   = VALUES(notify_start_advance_days),
        notify_end_advance_enabled  = VALUES(notify_end_advance_enabled),
        notify_start_advance_enabled = VALUES(notify_start_advance_enabled),
        notify_assignee_only        = VALUES(notify_assignee_only),
        updated_by                  = VALUES(updated_by)
    ');
    $stmt->bind_param('siiiiiiiiii', $projectId, $emailAlert, $notifyDelay, $notifyAssign, $notifyMention, $notifyAdvanceDays, $notifyStartAdvanceDays, $notifyEndAdvEnabled, $notifyStartAdvEnabled, $notifyAssigneeOnly, $updatedBy);
    $stmt->execute();
    $stmt->close();

    sendJson([
      'ok'       => true,
      'settings' => [
        'email_alert_enabled'      => $emailAlert,
        'notify_delay_alert'       => $notifyDelay,
        'notify_task_assign'       => $notifyAssign,
        'notify_mention'           => $notifyMention,
        'notify_advance_days'      => $notifyAdvanceDays,
        'notify_start_advance_days'=> $notifyStartAdvanceDays,
        'notify_end_advance_enabled'   => $notifyEndAdvEnabled,
        'notify_start_advance_enabled' => $notifyStartAdvEnabled,
        'notify_assignee_only'         => $notifyAssigneeOnly,
        'updated_at'               => date('Y-m-d H:i:s'),
      ],
    ]);
  }

  sendError('不明なアクションです', 400);
}

sendError('対応していないメソッドです', 405);


// ──────────────────────────────────────────
// ヘルパー: WebSocket サーバーへ通知プッシュ (Phase 5-2)
// ──────────────────────────────────────────
function _pushNotificationToWs(array $createdNotifications): void {
  if (empty($createdNotifications)) return;

  // Phase 5-7: 一括送信に変更（N回curl → 1回curl）
  // WSサーバー停止時のタイムアウト累積でPHP max_execution_time超過を防止
  $batch = [];
  foreach ($createdNotifications as $item) {
    $batch[] = [
      'id'          => (int)$item['id'],
      'user_id'     => (int)$item['user_id'],
      'type'        => $item['type'],
      'title'       => $item['title'] ?? '',
      'body'        => $item['body'] ?? '',
      'ref_task_id' => $item['ref_task_id'] ?? '',
      'created_at'  => date('Y-m-d H:i:s'),
      'category'    => $item['category'] ?? 'mention',  // Phase 5-7: ハードコード修正
      'is_read'     => 0,
    ];
  }

  $payload = json_encode(['notifications' => $batch]);

  // WebSocketサーバーへ一括HTTP POST（ローカルのみ）
  $url = 'http://127.0.0.1:3001/push_notification_batch';
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 2,
    CURLOPT_CONNECTTIMEOUT => 1,
  ]);
  @curl_exec($ch);   // エラー抑制: WSサーバー停止時もPHP継続
  curl_close($ch);
}

/**
 * プロジェクト通知設定を取得（未登録時はデフォルト値）
 * Phase 5-6: 通知送信制御用
 */
function _getNotifSettings(mysqli $db, string $projectId): array {
  $stmt = $db->prepare(
    'SELECT email_alert_enabled, notify_delay_alert, notify_task_assign, notify_mention, notify_advance_days, notify_start_advance_days, notify_end_advance_enabled, notify_start_advance_enabled, notify_assignee_only
     FROM project_notification_settings WHERE project_id = ?'
  );
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  $stmt->close();

  if (!$row) {
    return [
      'email_alert_enabled'      => 0,
      'notify_delay_alert'       => 1,
      'notify_task_assign'       => 1,
      'notify_mention'           => 1,
      'notify_advance_days'      => 3,
      'notify_start_advance_days'=> 3,
      'notify_end_advance_enabled'   => 1,
      'notify_start_advance_enabled' => 1,
      'notify_assignee_only'         => 1,
    ];
  }
  return [
    'email_alert_enabled'      => (int)$row['email_alert_enabled'],
    'notify_delay_alert'       => (int)$row['notify_delay_alert'],
    'notify_task_assign'       => (int)$row['notify_task_assign'],
    'notify_mention'           => (int)$row['notify_mention'],
    'notify_advance_days'      => (int)$row['notify_advance_days'],
    'notify_start_advance_days'=> (int)$row['notify_start_advance_days'],
    'notify_end_advance_enabled'   => (int)($row['notify_end_advance_enabled'] ?? 1),
    'notify_start_advance_enabled' => (int)($row['notify_start_advance_enabled'] ?? 1),
    'notify_assignee_only'         => (int)($row['notify_assignee_only'] ?? 1),
  ];
}

function _notificationTargetIsProjectMember(mysqli $db, string $projectId, int $targetUserId): bool {
  if ($projectId === '' || $targetUserId <= 0) return false;
  foreach (getProjectMembers($db, $projectId) as $member) {
    $memberUserId = (int)($member['user_id'] ?? 0);
    if ($memberUserId === $targetUserId) return true;
  }
  return false;
}

// ──────────────────────────────────────────
// ヘルパー: 通知レコード作成
// ──────────────────────────────────────────
function _createNotification(
  $db, $userId, $projectId, $category, $type,
  $title, $body, $refTaskId, $fromUserId
): int {
  if (!$userId || !$title) return 0;
  $stmt = $db->prepare('
    INSERT INTO notifications
      (user_id, project_id, category, type, title, body, ref_task_id, from_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ');
  $stmt->bind_param('issssssi', $userId, $projectId, $category, $type, $title, $body, $refTaskId, $fromUserId);
  $stmt->execute();
  $id = (int)$stmt->insert_id;
  $stmt->close();
  return $id;
}
