<?php
/**
 * Outlookカレンダー（ICS連携）予定インポート機能 — 連携API
 * =====================================================
 * 参照: docs/office-calendar-import-design.md（5節）
 *
 * Googleカレンダー連携（api/calendar_import.php）と異なり、Azure AD OAuthは
 * 一切使用しない（2節参照: 御社テナントのrisk-based step-up consentにより
 * 一般ユーザーの同意がブロックされることを実機検証で確認したため）。
 * 代わりにOutlook/Exchange Onlineの「予定表を公開する」機能で発行される
 * ICS購読URLを、ユーザー自身がこのAPI経由で登録する方式を採る。
 *
 * 本APIの役割は「ICS購読URLの検証・保管・取得・パース」までに限定する。
 * タスクの生成・追加処理は行わない（gantt-collab.html側フロントエンドJSの
 * 責務。設計書6.2節参照）。
 *
 * エンドポイント:
 *   GET  /api/office_calendar_import.php?action=status      → 連携状態取得
 *   POST /api/office_calendar_import.php?action=connect     → ics_url検証・保存
 *   POST /api/office_calendar_import.php?action=disconnect  → 連携解除
 *   GET  /api/office_calendar_import.php?action=list_events → 予定一覧取得（JSON、last_fetched_at以外のDB書き込みなし）
 */

// ─── .env 読み込み（calendar_import.php と同一パターン） ──
// WEBGANTT_TOKEN_ENCRYPTION_KEY はGoogle連携用に発行済みの既存鍵をそのまま
// 流用する（設計書4.2節）。新規鍵の発行は不要。
$envFile = __DIR__ . '/.env';
if (file_exists($envFile)) {
  $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
  foreach ($lines as $line) {
    if (str_starts_with(trim($line), '#')) continue;
    $eqPos = strpos($line, '=');
    if ($eqPos === false) continue;
    $key = trim(substr($line, 0, $eqPos));
    $val = trim(substr($line, $eqPos + 1));
    if ($key && getenv($key) === false) {
      putenv($key . '=' . $val);
    }
  }
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/vendor/autoload.php';
handlePreflight();

use Sabre\VObject\Reader;
use Sabre\VObject\Recur\EventIterator;

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$db     = getDb();

define('TOKEN_ENCRYPTION_KEY', getenv('WEBGANTT_TOKEN_ENCRYPTION_KEY') ?: '');
const MAX_RANGE_DAYS = 31;        // 設計書5節・4.3節: 最大1ヵ月（Google版と同一上限）
const ICS_FETCH_TIMEOUT_SEC = 10; // 設計書5.2節

// ─── URL暗号化ヘルパー（設計書4.2節: calendar_import.php と全く同じロジックを複製） ──
function encryptToken(string $plain): string {
  if (!TOKEN_ENCRYPTION_KEY) {
    sendError('サーバー設定エラー: WEBGANTT_TOKEN_ENCRYPTION_KEY が未設定です', 500);
  }
  $iv = random_bytes(openssl_cipher_iv_length('aes-256-cbc'));
  $cipherText = openssl_encrypt($plain, 'aes-256-cbc', TOKEN_ENCRYPTION_KEY, 0, $iv);
  if ($cipherText === false) {
    sendError('暗号化エラー', 500);
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

// ─── DBから該当ユーザーの連携行を取得 ──────────────────
function getOfficeTokenRow(mysqli $db, int $userId): ?array {
  $stmt = $db->prepare('SELECT * FROM office_calendar_tokens WHERE user_id = ? LIMIT 1');
  $stmt->bind_param('i', $userId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  return $row ?: null;
}

/**
 * ICS購読URLへHTTP GETを行い、レスポンス本文を取得する。
 * 失敗時は null を返す（呼び出し側でエラーハンドリング）。
 * 設計書5.2節・5.3節: curlでタイムアウト10秒程度。
 */
function fetchIcsBody(string $url): ?array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => ICS_FETCH_TIMEOUT_SEC,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 3,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_HTTPHEADER     => ['User-Agent: WebGantt-ICS-Import/1.0'],
  ]);
  $body = curl_exec($ch);
  $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $contentType = curl_getinfo($ch, CURLINFO_CONTENT_TYPE) ?: '';
  $errNo = curl_errno($ch);
  $err = curl_error($ch);
  curl_close($ch);

  if ($errNo !== 0 || $body === false) {
    error_log('[office_calendar_import.php] ICS取得failed (curl): ' . $err);
    return null;
  }
  if ($httpCode < 200 || $httpCode >= 300) {
    error_log('[office_calendar_import.php] ICS取得failed (http ' . $httpCode . ')');
    return null;
  }
  return ['body' => $body, 'contentType' => $contentType, 'httpCode' => $httpCode];
}

/**
 * Content-Type が text/calendar 系であるかの緩い判定（設計書5.2節）。
 * Outlookの実サーバーが application/octet-stream 等を返す可能性も考慮し、
 * 最終的には本文のBEGIN:VCALENDAR有無での判定を優先する。
 */
function looksLikeCalendarContentType(string $contentType): bool {
  return stripos($contentType, 'text/calendar') !== false
    || stripos($contentType, 'application/octet-stream') !== false
    || $contentType === '';
}

/**
 * ICS本文をパースし、指定期間内の予定（単発予定・繰り返し予定の展開後インスタンス
 * すべてを含む）を配列で返す。パース失敗時は null。
 * 設計書5.3節・7.1節。
 *
 * @param string $icsBody ICSデータ本体
 * @param DateTimeImmutable $rangeStart 期間開始（00:00:00）
 * @param DateTimeImmutable $rangeEndExclusive 期間終了の翌日0時（排他的上限）
 * @return array|null
 */
function parseIcsEvents(string $icsBody, DateTimeImmutable $rangeStart, DateTimeImmutable $rangeEndExclusive): ?array {
  try {
    $vcalendar = Reader::read($icsBody, Reader::OPTION_FORGIVING);
  } catch (\Throwable $e) {
    error_log('[office_calendar_import.php] ICSパース失敗: ' . $e->getMessage());
    return null;
  }

  if (!isset($vcalendar->VEVENT)) {
    // VEVENTが1件も無くてもパース自体は成功とみなす（空の予定表として扱う）
    return [];
  }

  $events = [];
  $seq = 0;

  foreach ($vcalendar->VEVENT as $vevent) {
    $isRecurring = isset($vevent->RRULE);

    if ($isRecurring) {
      // 繰り返し予定: EventIteratorで期間内のインスタンスに展開
      // （設計書7.1節補足2: Google版の singleEvents=true 相当）
      try {
        $it = new EventIterator($vcalendar, (string)$vevent->UID);
      } catch (\Throwable $e) {
        error_log('[office_calendar_import.php] RRULE展開失敗(UID=' . (string)$vevent->UID . '): ' . $e->getMessage());
        continue;
      }
      // 無限リピート等での暴走防止に展開件数の上限を設ける
      $guard = 0;
      while ($it->valid() && $guard < 2000) {
        $guard++;
        $occStart = $it->getDtStart();
        $occEnd = $it->getDtEnd();
        if ($occStart && $occEnd) {
          $occStartDt = DateTimeImmutable::createFromInterface($occStart);
          if ($occStartDt >= $rangeEndExclusive) {
            break; // 期間外（未来方向）に達したら打ち切り
          }
          // 展開後インスタンスの終日判定は、元のVEVENTのDTSTARTが日付のみ
          // (VALUE=DATE) かどうかで行う（EventIteratorに isAllDay() は存在しないため）
          $occIsAllDay = isset($vevent->DTSTART) && !$vevent->DTSTART->hasTime();
          $mapped = mapVEventOccurrenceToArray($vevent, $occStart, $occEnd, $occIsAllDay);
          if ($mapped && eventOverlapsRange($mapped, $rangeStart, $rangeEndExclusive)) {
            $mapped['id'] = 'office-' . md5((string)$vevent->UID . '-' . $occStartDt->format('Ymd\THis'));
            $events[] = $mapped;
          }
        }
        $it->next();
      }
    } else {
      // 単発予定
      $dtstart = $vevent->DTSTART ?? null;
      $dtend = $vevent->DTEND ?? null;
      if (!$dtstart) continue;
      $startDateTimeObj = $dtstart->getDateTime();
      $isAllDay = !$dtstart->hasTime();
      $endDateTimeObj = $dtend ? $dtend->getDateTime() : $startDateTimeObj;

      $mapped = mapVEventOccurrenceToArray($vevent, $startDateTimeObj, $endDateTimeObj, $isAllDay);
      if ($mapped && eventOverlapsRange($mapped, $rangeStart, $rangeEndExclusive)) {
        $mapped['id'] = 'office-' . md5((string)($vevent->UID ?? uniqid('', true)) . '-' . $seq);
        $events[] = $mapped;
      }
    }
    $seq++;
  }

  // 開始日でソート
  usort($events, function ($a, $b) {
    return strcmp($a['startDate'], $b['startDate']);
  });

  return $events;
}

/**
 * VEVENT（またはその1インスタンス）を { summary, startDate, endDate } 形式に変換する。
 * 時刻情報は無視し日付部分のみ抽出する（設計書7.1節、Google版と同一方針）。
 * 終日イベントの DTEND は排他的（翌日を指す）ため1日減算する（設計書7.1節補足）。
 */
function mapVEventOccurrenceToArray($vevent, DateTimeInterface $start, DateTimeInterface $end, bool $isAllDay): ?array {
  $startDate = $start->format('Y-m-d');
  $endDateRaw = $end->format('Y-m-d');

  $endDate = $endDateRaw;
  if ($isAllDay) {
    $endDt = (new DateTimeImmutable($endDateRaw))->modify('-1 day');
    $endDate = $endDt->format('Y-m-d');
    if (strtotime($endDate) < strtotime($startDate)) {
      $endDate = $startDate;
    }
  }

  $summary = isset($vevent->SUMMARY) ? (string)$vevent->SUMMARY : '';

  return [
    'summary'   => $summary !== '' ? $summary : '(無題の予定)',
    'startDate' => $startDate,
    'endDate'   => $endDate,
  ];
}

/**
 * mapVEventOccurrenceToArray() の結果が指定期間と重なるか判定する。
 */
function eventOverlapsRange(array $mapped, DateTimeImmutable $rangeStart, DateTimeImmutable $rangeEndExclusive): bool {
  $evStart = new DateTimeImmutable($mapped['startDate']);
  $evEnd = new DateTimeImmutable($mapped['endDate']);
  $rangeEndInclusive = $rangeEndExclusive->modify('-1 day');
  return $evEnd >= $rangeStart && $evStart <= $rangeEndInclusive;
}

// ═══════════════════════════════════════════════════════════
// GET: status（連携状態取得）
// ═══════════════════════════════════════════════════════════
if ($method === 'GET' && $action === 'status') {
  $user = requireAuth();
  $tokenRow = getOfficeTokenRow($db, $user['id']);

  if (!$tokenRow) {
    sendJson(['connected' => false]);
  }

  sendJson([
    'connected'    => true,
    'displayLabel' => $tokenRow['display_label'],
  ]);
}

// ═══════════════════════════════════════════════════════════
// POST: connect（ics_url検証・保存）— 設計書5.2節
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'connect') {
  $user = requireAuth();
  $body = getJsonBody();

  $icsUrl = trim((string)($body['ics_url'] ?? ''));
  $displayLabel = trim((string)($body['display_label'] ?? ''));

  // 1. URL形式の簡易検証
  if ($icsUrl === '' || !preg_match('#^https://#i', $icsUrl) || strlen($icsUrl) > 2048) {
    sendError('連携に失敗しました。URLが正しいか、公開設定が有効か確認してください', 400);
  }
  if (filter_var($icsUrl, FILTER_VALIDATE_URL) === false) {
    sendError('連携に失敗しました。URLが正しいか、公開設定が有効か確認してください', 400);
  }

  // 2. 実際にHTTP GETを試行
  $fetched = fetchIcsBody($icsUrl);
  if ($fetched === null) {
    sendError('連携に失敗しました。URLが正しいか、公開設定が有効か確認してください', 400);
  }

  // 3. Content-Type確認
  if (!looksLikeCalendarContentType($fetched['contentType'])) {
    error_log('[office_calendar_import.php] connect: 想定外のContent-Type: ' . $fetched['contentType']);
    // Content-Typeが想定外でも本文検証（4.）でBEGIN:VCALENDARがあれば許容する
  }

  // 4. パース検証（BEGIN:VCALENDARが含まれるか等）
  if (stripos($fetched['body'], 'BEGIN:VCALENDAR') === false) {
    sendError('連携に失敗しました。URLが正しいか、公開設定が有効か確認してください', 400);
  }
  try {
    Reader::read($fetched['body'], Reader::OPTION_FORGIVING);
  } catch (\Throwable $e) {
    error_log('[office_calendar_import.php] connect: パース検証失敗: ' . $e->getMessage());
    sendError('連携に失敗しました。URLが正しいか、公開設定が有効か確認してください', 400);
  }

  // 5. 検証OK → 暗号化して upsert
  $encUrl = encryptToken($icsUrl);
  $labelToSave = $displayLabel !== '' ? $displayLabel : null;

  $stmt = $db->prepare(
    'INSERT INTO office_calendar_tokens (user_id, ics_url, display_label, last_fetched_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE ics_url = VALUES(ics_url), display_label = VALUES(display_label), last_fetched_at = VALUES(last_fetched_at)'
  );
  $stmt->bind_param('iss', $user['id'], $encUrl, $labelToSave);
  if (!$stmt->execute()) {
    error_log('[office_calendar_import.php] connect: DB保存エラー: ' . $stmt->error);
    sendError('連携情報の保存に失敗しました。しばらくしてから再度お試しください', 500);
  }

  sendJson(['ok' => true, 'displayLabel' => $labelToSave]);
}

// ═══════════════════════════════════════════════════════════
// POST: disconnect（連携解除）
// ═══════════════════════════════════════════════════════════
if ($method === 'POST' && $action === 'disconnect') {
  $user = requireAuth();

  $stmt = $db->prepare('DELETE FROM office_calendar_tokens WHERE user_id = ?');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();

  sendJson(['ok' => true]);
}

// ═══════════════════════════════════════════════════════════
// GET: list_events（予定一覧取得・JSON返却）— 設計書5.3節
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

  $rangeDays = (int)round(($endTs - $startTs) / 86400);
  if ($rangeDays > MAX_RANGE_DAYS) {
    sendError('期間は最大' . MAX_RANGE_DAYS . '日までです', 400);
  }

  $tokenRow = getOfficeTokenRow($db, $user['id']);
  if (!$tokenRow) {
    sendError('Outlookカレンダーと連携していません', 400);
  }

  $icsUrl = decryptToken($tokenRow['ics_url']);
  if ($icsUrl === null) {
    sendError('連携が無効になりました。再度連携してください', 401);
  }

  // 都度HTTP GET（キャッシュはしない。設計書5.3節）
  $fetched = fetchIcsBody($icsUrl);
  if ($fetched === null) {
    sendError('予定の読み込みに失敗しました。時間をおいて再試行してください', 502);
  }

  $rangeStart = new DateTimeImmutable($startDateStr . ' 00:00:00');
  $rangeEndExclusive = (new DateTimeImmutable($endDateStr . ' 00:00:00'))->modify('+1 day');

  $events = parseIcsEvents($fetched['body'], $rangeStart, $rangeEndExclusive);
  if ($events === null) {
    // 設計書8節: Outlook側で公開設定が解除された等でパース不能 → 再連携を促す
    sendError('連携が無効になりました。再度連携してください', 401);
  }

  // last_fetched_at を更新（設計書5.3節手順7）
  $stmt = $db->prepare('UPDATE office_calendar_tokens SET last_fetched_at = NOW() WHERE user_id = ?');
  $stmt->bind_param('i', $user['id']);
  $stmt->execute();

  sendJson(['events' => $events]);
}

// ─── 未対応 ────────────────────────────────────────────
sendError('未対応のアクション: ' . $action, 404);
