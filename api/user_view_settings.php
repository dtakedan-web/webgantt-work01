<?php
/**
 * ガントチャート ユーザー個別ビュー設定 API (Phase 2-D)
 * =====================================================
 * プロジェクトごとにユーザー個別の表示設定・システム設定を保存・取得する。
 *
 * エンドポイント:
 *   GET  /api/user_view_settings.php?project=XXX
 *        → 指定プロジェクトの個人ビュー設定 JSON を返す
 *          レコードが存在しない場合は {"settings": null} を返す
 *
 *   POST /api/user_view_settings.php
 *        body: { "project": "XXX", "settings": { ... } }
 *        → 設定を UPSERT 保存する
 *
 * settings JSON の期待する構造:
 *   {
 *     "viewOptions":   { ... },   // 表示設定（viewMode, leftPaneFoldMode 等）
 *     "systemOptions": { ... },   // システム設定（行高さ、メッセージ設定 等）
 *     "annMode":       boolean,   // 引き出し線注記モード状態
 *     "viewStart":     "YYYY/MM/DD", // 表示開始日
 *     "collapsedRows": [{ "rowId": "...", "collapsed": bool }, ...] // 各行の折り畳み状態
 *   }
 *
 * セキュリティ:
 *   - 全エンドポイントで認証必須 (requireAuth)
 *   - プロジェクトへのアクセス権限チェック (canAccessProject)
 *   - settings の JSON は最大 512KB まで受け付ける
 */

require_once __DIR__ . '/config.php';
handlePreflight();

// ─── 認証 ────────────────────────────────────────────────────────────
$user   = requireAuth();
$method = $_SERVER['REQUEST_METHOD'];
$db     = getDb();

$userId   = (int)$user['id'];
$userRole = $user['role'];

// ─── GET: 設定取得 ────────────────────────────────────────────────────
if ($method === 'GET') {
    $projectId = trim($_GET['project'] ?? '');

    if (!$projectId) {
        sendError('project パラメータは必須です');
    }

    // アクセス権限チェック
    if (!canAccessProject($db, $userId, $userRole, $projectId)) {
        sendError('このプロジェクトにアクセスする権限がありません', 403);
    }

    $stmt = $db->prepare(
        'SELECT settings FROM user_view_settings WHERE user_id = ? AND project_id = ?'
    );
    $stmt->bind_param('is', $userId, $projectId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();

    if (!$row) {
        // レコードなし → クライアント側でデフォルトを使用
        sendJson(['settings' => null]);
    }

    $settings = json_decode($row['settings'], true);
    sendJson(['settings' => $settings]);
}

// ─── POST: 設定保存 ───────────────────────────────────────────────────
if ($method === 'POST') {
    $body      = getJsonBody();
    $projectId = trim($body['project'] ?? '');
    $settings  = $body['settings'] ?? null;

    if (!$projectId) {
        sendError('project フィールドは必須です');
    }
    if (!is_array($settings)) {
        sendError('settings は JSON オブジェクトで送信してください');
    }

    // アクセス権限チェック
    if (!canAccessProject($db, $userId, $userRole, $projectId)) {
        sendError('このプロジェクトにアクセスする権限がありません', 403);
    }

    // settings の許容フィールドを検証・フィルタリング（不要フィールドの混入を防ぐ）
    $allowed = ['viewOptions', 'systemOptions', 'annMode', 'viewStart', 'collapsedRows'];
    $filtered = array_intersect_key($settings, array_flip($allowed));

    // collapsedRows は [{rowId, collapsed}] 配列のみ許容
    if (isset($filtered['collapsedRows'])) {
        if (!is_array($filtered['collapsedRows'])) {
            $filtered['collapsedRows'] = [];
        } else {
            $filtered['collapsedRows'] = array_values(array_filter(
                array_map(function ($item) {
                    if (!is_array($item)) return null;
                    $rowId     = isset($item['rowId']) ? (string)$item['rowId'] : null;
                    $collapsed = isset($item['collapsed']) ? (bool)$item['collapsed'] : false;
                    if (!$rowId) return null;
                    return ['rowId' => $rowId, 'collapsed' => $collapsed];
                }, $filtered['collapsedRows'])
            ));
        }
    }

    $settingsJson = json_encode($filtered, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

    // 512KB 上限チェック
    if (strlen($settingsJson) > 524288) {
        sendError('settings データが大きすぎます（上限 512KB）');
    }

    $stmt = $db->prepare(
        'INSERT INTO user_view_settings (user_id, project_id, settings)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE settings = VALUES(settings)'
    );
    $stmt->bind_param('iss', $userId, $projectId, $settingsJson);

    if (!$stmt->execute()) {
        sendError('設定の保存に失敗しました: ' . $db->error, 500);
    }

    sendJson(['ok' => true]);
}

// ─── それ以外のメソッドは 405 ─────────────────────────────────────────
sendError('許可されていないメソッドです', 405);
