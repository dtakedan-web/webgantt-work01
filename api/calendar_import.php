<?php
/**
 * Googleカレンダー予定インポート機能 — 連携API (Phase: 外部連携)
 * =====================================================
 * 参照: docs/google-calendar-import-design.md（6節・方針転換版）
 *
 * 本APIの役割は「Google認可・トークン管理・予定データの取得」までに限定する。
 * タスクの生成・追加処理は行わない（gantt-collab.html側フロントエンドJSの
 * 責務。6.2節参照）。
 *
 * エンドポイント:
 *   GET  /api/calendar_import.php?action=status      → 連携状態取得
 *   GET  /api/calendar_import.php?action=authorize   → Google認可URLへリダイレクト
 *   GET  /api/calendar_import.php?action=callback    → Googleからの認可コード受け取り
 *   POST /api/calendar_import.php?action=disconnect  → 連携解除
 *   GET  /api/calendar_import.php?action=list_events → 予定一覧取得（JSON、DB書き込みなし）
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/vendor/autoload.php';
handlePreflight();

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$db     = getDb();

// ─── Google OAuth 設定（.env経由） ─────────────────────
define('GOOGLE_CLIENT_ID',     getenv('WEBGANTT_GOOGLE_CLIENT_ID')     ?: '');
define('GOOGLE_CLIENT_SECRET', getenv('WEBGANTT_GOOGLE_CLIENT_SECRET') ?: '');
define('GOOGLE_REDIRECT_URI',  getenv('WEBGANTT_GOOGLE_REDIRECT_URI')  ?: '');
define('TOKEN_ENCRYPTION_KEY', getenv('WEBGANTT_TOKEN_ENCRYPTION_KEY') ?: '');

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
// openid/email: カレンダーへの書き込み権限は一切含まない識別用スコープ。
// 連携先Googleアカウントのメールアドレス（表示用、5.1節 google_email カラム）を
// id_token から取得するために追加。calendar.readonly と合わせても read-only の設計方針は維持される。
const GOOGLE_IDENTITY_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email'];
const MAX_RANGE_DAYS = 31; // 5.1節・4.3節: 最大1ヵ月

// ─── トークン暗号化ヘルパー（5.2節: openssl_encrypt/decrypt, AES-256-CBC, IV per-token） ──
function encryptToken(string $plain): string {
  if (!TOKEN_ENCRYPTION_KEY) {
    sendError('サーバー設定エラー: WEBGANTT_TOKEN_ENCRYPTION_KEY が未設定です', 500);
  }
  $iv = random_bytes(openssl_cipher_iv_length('aes-256-cbc'));
  $cipherText = openssl_encrypt($plain, 'aes-256-cbc', TOKEN_ENCRYPTION_KEY, 0, $iv);
  if ($cipherText === false) {
    sendError('トークン暗号化エラー', 500);
  }
  return base64_encode($iv) . ':' . base64_encode($cipherText);
}

function decryptToken(string $stored): ?string {
  if (!TOKEN_ENCRYPTION_KEY) return null;
  $parts = explode(':', $stored, 2);
  if (count($parts) !== 2) return null;
  $iv = base64_decode($parts[0]);
  $cipherText = base64_decode($parts[1]);
  if ($iv === false || $cipherText === false) return null;
  $plain = openssl_decrypt($cipherText, 'aes-256-cbc', TOKEN_ENCRYPTION_KEY, 0, $iv);
  return $plain === false ? null : $plain;
}

// ─── Google\Client 生成 ────────────────────────────────
function createGoogleClient(): Google\Client {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    sendError('サーバー設定エラー: Google OAuth用の環境変数が未設定です', 500);
  }
  $client = new Google\Client();
  $client->setClientId(GOOGLE_CLIENT_ID);
  $client->setClientSecret(GOOGLE_CLIENT_SECRET);
  $client->setRedirectUri(GOOGLE_REDIRECT_URI);
  $client->addScope(GOOGLE_CALENDAR_SCOPE);
  foreach (GOOGLE_IDENTITY_SCOPES as $s) {
    $client->addScope($s);
  }
  $client->setAccessType('offline');   // refresh_token 取得のため
  $client->setPrompt('consent');
  return $client;
}

// ─── DBから該当ユーザーの連携行を取得 ──────────────────
function getTokenRow(mysqli $db, int $userId): ?array {
  $stmt = $db->prepare('SELECT * FROM google_calendar_tokens WHERE user_id = ? LIMIT 1');
  $stmt->bind_param('i', $userId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  return $row ?: null;
}

/**
 * 有効なアクセストークン（復号済み・平文）を取得する。
 * 期限切れの場合は refresh_token で自動更新し、DBも更新する（9節参照）。
 * リフレッシュにも失敗した場合は null を返す（呼び出し側で再連携を促す）。
 */
function getValidAccessToken(mysqli $db, int $userId, array $tokenRow): ?string {
  $accessToken = decryptToken($tokenRow['access_token']);
  $refreshToken = decryptToken($tokenRow['refresh_token']);
  if ($accessToken === null || $refreshToken === null) {
    return null;
  }

  $expiresAt = strtotime($tokenRow['token_expires_at']);
  $needsRefresh = ($expiresAt === false) || ($expiresAt <= time() + 60);

  if (!$needsRefresh) {
    return $accessToken;
  }

  // ── リフレッシュ ──
  $client = createGoogleClient();
  $client->setAccessToken(['access_token' => $accessToken, 'refresh_token' => $refreshToken]);
  try {
    $newToken = $client->fetchAccessTokenWithRefreshToken($refreshToken);
  } catch (\Throwable $e) {
    error_log('[calendar_import.php] トークンリフレッシュ失敗: ' . $e->getMessage());
    return null;
  }

  if (empty($newToken['access_token'])) {
    return null;
  }

  $newAccessToken = $newToken['access_token'];
  $newExpiresIn = (int)($newToken['expires_in'] ?? 3600);
  $newExpiresAt = date('Y-m-d H:i:s', time() + $newExpiresIn);
  // Google はリフレッシュ応答に refresh_token を含めないことが多いため既存値を保持
  $newRefreshToken = $newToken['refresh_token'] ?? $refreshToken;

  $encAccess = encryptToken($newAccessToken);
  $encRefresh = encryptToken($newRefreshToken);
  $stmt = $db->prepare('UPDATE google_calendar_tokens SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE user_id = ?');
  $stmt->bind_param('sssi', $encAccess, $encRefresh, $newExpiresAt, $userId);
  $stmt->execute();

  return $newAccessToken;
}

// ═══════════════════════════════════════════════════════════
// GET: status（連携状態取得）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'status') {
  $user = requireAuth();
  $tokenRow = getTokenRow($db, $user['id']);

  if (!$tokenRow) {
    sendJson(['connected' => false]);
  }

  sendJson([
    'connected'  => true,
    'googleEmail' => $tokenRow['google_email'],
  ]);
}

// ═══════════════════════════════════════════════════════════
// GET: authorize（Google認可URLへリダイレクト）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'authorize') {
  $user = requireAuth();

  // CSRF対策トークン（stateパラメータ）をPHPネイティブセッションに保存
  // （既存の認証・セッション処理（sessions テーブル・Cookie方式）には一切手を加えない。10節参照）
  session_start();
  $state = bin2hex(random_bytes(16));
  $_SESSION['gcal_oauth_state'] = $state;
  $_SESSION['gcal_oauth_user_id'] = $user['id'];

  $client = createGoogleClient();
  $client->setState($state);
  $authUrl = $client->createAuthUrl();

  header('Location: ' . $authUrl);
  exit;
}

// ═══════════════════════════════════════════════════════════
// GET: callback（Googleからの認可コード受け取り）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'callback') {
  $user = requireAuth();

  $code  = $_GET['code'] ?? '';
  $state = $_GET['state'] ?? '';

  session_start();
  $expectedState = $_SESSION['gcal_oauth_state'] ?? null;
  unset($_SESSION['gcal_oauth_state']);

  if (!$code || !$state || !$expectedState || !hash_equals($expectedState, $state)) {
    // 9節: stateパラメータ不一致（CSRF疑い）→ コールバック処理を中断しエラー表示
    header('Location: ' . buildFrontendReturnUrl(['gcal_error' => 'state_mismatch']));
    exit;
  }

  $client = createGoogleClient();
  try {
    $token = $client->fetchAccessTokenWithAuthCode($code);
  } catch (\Throwable $e) {
    error_log('[calendar_import.php] 認可コード交換失敗: ' . $e->getMessage());
    header('Location: ' . buildFrontendReturnUrl(['gcal_error' => 'token_exchange_failed']));
    exit;
  }

  if (empty($token['access_token'])) {
    header('Location: ' . buildFrontendReturnUrl(['gcal_error' => 'token_exchange_failed']));
    exit;
  }

  $accessToken  = $token['access_token'];
  $refreshToken = $token['refresh_token'] ?? null;
  $expiresIn    = (int)($token['expires_in'] ?? 3600);
  $expiresAt    = date('Y-m-d H:i:s', time() + $expiresIn);

  // refresh_token は初回同意時のみ返却される。既存行がある場合は既存値を維持。
  $existing = getTokenRow($db, $user['id']);
  if (!$refreshToken) {
    if ($existing && !empty($existing['refresh_token'])) {
      $refreshToken = decryptToken($existing['refresh_token']);
    }
  }
  if (!$refreshToken) {
    // refresh_token が取得できない場合は再連携が必要（access_type=offline+promptで基本的に回避される）
    error_log('[calendar_import.php] refresh_token 取得なし（user_id=' . $user['id'] . '）');
    header('Location: ' . buildFrontendReturnUrl(['gcal_error' => 'no_refresh_token']));
    exit;
  }

  // 連携先Googleアカウントのメールアドレスを取得（表示用、id_tokenから抽出）
  $googleEmail = null;
  try {
    if (!empty($token['id_token'])) {
      $payload = $client->verifyIdToken($token['id_token']);
      if (is_array($payload) && !empty($payload['email'])) {
        $googleEmail = $payload['email'];
      }
    }
  } catch (\Throwable $e) {
    error_log('[calendar_import.php] id_token検証失敗(表示用メール取得のみ・処理は続行): ' . $e->getMessage());
  }

  $encAccess  = encryptToken($accessToken);
  $encRefresh = encryptToken($refreshToken);

  $stmt = $db->prepare(
    'INSERT INTO google_calendar_tokens (user_id, google_email, access_token, refresh_token, token_expires_at, scope)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE google_email = VALUES(google_email), access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token), token_expires_at = VALUES(token_expires_at), scope = VALUES(scope)'
  );
  $scope = GOOGLE_CALENDAR_SCOPE;
  $stmt->bind_param('isssss', $user['id'], $googleEmail, $encAccess, $encRefresh, $expiresAt, $scope);
  if (!$stmt->execute()) {
    error_log('[calendar_import.php] トークン保存エラー: ' . $stmt->error);
    header('Location: ' . buildFrontendReturnUrl(['gcal_error' => 'db_save_failed']));
    exit;
  }

  // 完了後、元のガント画面（モーダルが開いた状態）にリダイレクト（7.2節手順7）
  header('Location: ' . buildFrontendReturnUrl(['gcal_connected' => '1']));
  exit;
}

// ═══════════════════════════════════════════════════════════
// POST: disconnect（連携解除）
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'disconnect') {
  $user = requireAuth();

  $tokenRow = getTokenRow($db, $user['id']);
  if ($tokenRow) {
    // Google側のトークン失効APIも呼び出す（ベストエフォート）
    $accessToken = decryptToken($tokenRow['access_token']);
    if ($accessToken) {
      try {
        $client = createGoogleClient();
        $client->revokeToken($accessToken);
      } catch (\Throwable $e) {
        error_log('[calendar_import.php] トークン失効APIエラー(無視して続行): ' . $e->getMessage());
      }
    }
  }

  $stmt = $db->prepare('DELETE FROM google_calendar_tokens WHERE user_id = ?');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();

  sendJson(['ok' => true]);
}

// ═══════════════════════════════════════════════════════════
// GET: list_events（予定一覧取得・JSON返却・DB書き込みなし）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'list_events') {
  $user = requireAuth();

  $startDateStr = $_GET['start_date'] ?? '';
  $endDateStr   = $_GET['end_date'] ?? '';

  if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $startDateStr) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDateStr)) {
    sendError('start_date, end_date は YYYY-MM-DD 形式で指定してください');
  }

  $startTs = strtotime($startDateStr);
  $endTs   = strtotime($endDateStr);
  if ($startTs === false || $endTs === false || $endTs < $startTs) {
    sendError('日付の指定が正しくありません');
  }

  // 4.3節: 上限は開始日から最大1ヵ月後まで
  $rangeDays = (int)round(($endTs - $startTs) / 86400);
  if ($rangeDays > MAX_RANGE_DAYS) {
    sendError('期間は最大' . MAX_RANGE_DAYS . '日までです', 400);
  }

  $tokenRow = getTokenRow($db, $user['id']);
  if (!$tokenRow) {
    sendError('Googleカレンダーと連携していません', 400);
  }

  $accessToken = getValidAccessToken($db, $user['id'], $tokenRow);
  if ($accessToken === null) {
    // 9節: リフレッシュトークンも無効 → 再連携を促す
    sendError('連携が無効になりました。再度連携してください', 401);
  }

  $client = createGoogleClient();
  $client->setAccessToken(['access_token' => $accessToken]);
  $service = new Google\Service\Calendar($client);

  // Calendar APIの時刻範囲はRFC3339。終了日は「翌日の0時」まで含めることで
  // end_date当日を含む範囲にする（8.1節: end.date排他仕様への配慮）
  $timeMin = date('Y-m-d\T00:00:00P', $startTs);
  $timeMax = date('Y-m-d\T00:00:00P', $endTs + 86400);

  try {
    $results = $service->events->listEvents('primary', [
      'timeMin'      => $timeMin,
      'timeMax'      => $timeMax,
      'singleEvents' => true,   // 8.1節補足2: 繰り返し予定を個別インスタンスに展開
      'orderBy'      => 'startTime',
      'maxResults'   => 250,
    ]);
  } catch (\Throwable $e) {
    error_log('[calendar_import.php] events.list 呼び出し失敗: ' . $e->getMessage());
    sendError('予定の読み込みに失敗しました。時間をおいて再試行してください', 502);
  }

  $events = [];
  foreach ($results->getItems() as $event) {
    $start = $event->getStart();
    $end   = $event->getEnd();

    // 終日 or 時刻指定の両対応。時刻情報は無視し日付部分のみ抽出（8.1節）
    $startDate = $start ? ($start->getDate() ?: substr((string)$start->getDateTime(), 0, 10)) : null;
    $endDateRaw = $end ? ($end->getDate() ?: substr((string)$end->getDateTime(), 0, 10)) : null;

    if (!$startDate || !$endDateRaw) {
      continue; // データ不備はスキップ
    }

    // 8.1節補足: end.date は終了日の翌日を指す（排他的）ため1日減算
    // ただし dateTime（時刻指定イベント）の場合は減算しない
    $endDate = $endDateRaw;
    if ($end && $end->getDate()) {
      $endDate = date('Y-m-d', strtotime($endDateRaw . ' -1 day'));
      // 終日1日イベントで減算後にstartより前になるケースの保護
      if (strtotime($endDate) < strtotime($startDate)) {
        $endDate = $startDate;
      }
    }

    $events[] = [
      'id'        => $event->getId(),
      'summary'   => $event->getSummary() ?: '(無題の予定)',
      'startDate' => $startDate,
      'endDate'   => $endDate,
    ];
  }

  sendJson(['events' => $events]);
}

// ─── フロントエンド復帰用URL生成（OAuthコールバック完了後） ──
function buildFrontendReturnUrl(array $queryParams): string {
  $base = getenv('WEBGANTT_MAIL_APP_BASE_URL') ?: 'https://ogma.mydns.jp/WebGantt';
  $url = rtrim($base, '/') . '/gantt/gantt-collab.html';
  $sep = '?';
  foreach ($queryParams as $k => $v) {
    $url .= $sep . urlencode($k) . '=' . urlencode($v);
    $sep = '&';
  }
  return $url;
}

// ─── 未対応 ────────────────────────────────────────────
sendError('未対応のアクション: ' . $action, 404);
