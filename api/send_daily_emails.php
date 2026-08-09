<?php
/**
 * 日次遅延digestメール送信 (Phase 5-9)
 * cron で毎日 08:00 JST に実行
 *
 * 処理フロー:
 *   1. .env 読み込み(cron実行時の環境変数注入)
 *   2. config.php / MailSender.php 読み込み
 *   3. 当日(JST)の delay_alert 通知を抽出
 *   4. email_alert_enabled=1 の PJ のみ対象
 *   5. 各PJの project_members から users.email が設定済みの者を取得
 *   6. ユーザーごとに digest 本文を構築 → MailSender->send()
 *   7. 結果をログ出力
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 takeda
 */

// ── .env 読み込み(cron実行時用) ──
$envFile = __DIR__ . '/.env';
if (file_exists($envFile)) {
  $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
  foreach ($lines as $line) {
    if (str_starts_with(trim($line), '#')) continue;
    $eqPos = strpos($line, '=');
    if ($eqPos === false) continue;
    $key = trim(substr($line, 0, $eqPos));
    $val = trim(substr($line, $eqPos + 1));
    if ($key) putenv($key . '=' . $val);
  }
}

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/MailSender.php';

// ── JST基準で当日の日付を取得 ──
$today = (new DateTime('today', new DateTimeZone('Asia/Tokyo')))->format('Y-m-d');

$db = getDb();
$mailer = new MailSender();
$stats = ['sent' => 0, 'skipped' => 0, 'failed' => 0];

// ── CONVERT_TZ が使えるか確認(タイムゾーンテーブル未設定の場合フォールバック) ──
$tzResult = $db->query("SELECT CONVERT_TZ('2026-08-04 12:00:00', 'UTC', '+09:00') as tz_test");
$tzRow = $tzResult->fetch_assoc();
$useConvertTz = ($tzRow && $tzRow['tz_test'] !== null);
$dateExpr = $useConvertTz
  ? "DATE(CONVERT_TZ(n.created_at, 'UTC', '+09:00'))"
  : "DATE(n.created_at)";

// ── 1. email_alert_enabled=1 の PJ 一覧を取得(collation エラー回避) ──
$stmt = $db->prepare(
  "SELECT pns.project_id, p.name as project_name
   FROM project_notification_settings pns
   JOIN projects p ON pns.project_id COLLATE utf8mb4_unicode_ci = p.project_id COLLATE utf8mb4_unicode_ci
   WHERE pns.email_alert_enabled = 1
     AND pns.notify_delay_alert = 1"
);
$stmt->execute();
$enabledProjects = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);

if (empty($enabledProjects)) {
  error_log("[gantt_mail] 日次送信: 対象PJなし(email_alert_enabled=1 のPJがありません)");
  exit(0);
}

foreach ($enabledProjects as $proj) {
  $projectId   = $proj['project_id'];
  $projectName = $proj['project_name'];

  // ── 2. 当日の delay_alert 通知を取得(PJ単位) ──
  $stmt = $db->prepare(
    "SELECT n.id, n.title, n.body, n.ref_task_id, n.created_at
     FROM notifications n
     WHERE n.project_id = ?
       AND n.type = 'delay_alert'
       AND $dateExpr = ?
     ORDER BY n.created_at DESC"
  );
  $stmt->bind_param('ss', $projectId, $today);
  $stmt->execute();
  $alerts = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);

  if (empty($alerts)) continue;  // 当日の遅延なし → スキップ

  // ── 3. 通知先メンバーを取得(email設定済みのみ) ──
  $assigneeOnly = getAssigneeOnlySetting($db, $projectId);

  if ($assigneeOnly) {
    // 担当者のみ: delay_alert の user_id が通知先
    $stmt = $db->prepare(
      "SELECT DISTINCT u.id, u.email, u.display_name
       FROM notifications n
       JOIN users u ON n.user_id = u.id
       WHERE n.project_id = ?
         AND n.type = 'delay_alert'
         AND $dateExpr = ?
         AND u.email IS NOT NULL AND u.email != ''"
    );
    $stmt->bind_param('ss', $projectId, $today);
  } else {
    // PJ全メンバー(collation エラー回避)
    $stmt = $db->prepare(
      "SELECT DISTINCT u.id, u.email, u.display_name
       FROM project_members pm
       JOIN users u ON pm.user_id = u.id
       WHERE pm.project_id COLLATE utf8mb4_unicode_ci = ? COLLATE utf8mb4_unicode_ci
         AND u.email IS NOT NULL AND u.email != ''"
    );
    $stmt->bind_param('s', $projectId);
  }
  $stmt->execute();
  $recipients = $stmt->get_result()->fetch_all(MYSQLI_ASSOC);

  if (empty($recipients)) {
    $stats['skipped']++;
    error_log("[gantt_mail] PJ=$projectId($projectName): 送信先なし(email未設定)");
    continue;
  }

  // ── 4. ユーザーごとに digest メール送信 ──
  foreach ($recipients as $rcpt) {
    $subject  = "【ガントチャート】$projectName の遅延アラート($today)";
    $htmlBody = buildDigestHtml($projectName, $projectId, $alerts, $today);
    $textBody = buildDigestText($projectName, $projectId, $alerts, $today);

    if ($mailer->send($rcpt['email'], $subject, $htmlBody, $textBody)) {
      $stats['sent']++;
      error_log("[gantt_mail] OK to={$rcpt['email']} PJ=$projectId($projectName)");
    } else {
      $stats['failed']++;
      error_log("[gantt_mail] FAIL to={$rcpt['email']} PJ=$projectId($projectName) err=" . $mailer->getLastError());
    }
  }
}

error_log("[gantt_mail] 日次送信完了 date=$today sent={$stats['sent']} skipped={$stats['skipped']} failed={$stats['failed']}");

// ── ヘルパー関数 ──

function getAssigneeOnlySetting(mysqli $db, string $projectId): bool
{
  $stmt = $db->prepare(
    "SELECT notify_assignee_only FROM project_notification_settings WHERE project_id = ?"
  );
  $stmt->bind_param('s', $projectId);
  $stmt->execute();
  $row = $stmt->get_result()->fetch_assoc();
  return (bool)($row['notify_assignee_only'] ?? 1);
}

function buildDigestHtml(string $projectName, string $projectId, array $alerts, string $today): string
{
  $baseUrl = getenv('WEBGANTT_MAIL_APP_BASE_URL') ?: 'https://ogma.mydns.jp/WebGantt';
  $ganttUrl = $baseUrl . '/gantt/gantt-collab.html?project=' . urlencode($projectId);

  $alertRows = '';
  foreach ($alerts as $a) {
    $alertRows .= "
      <tr>
        <td style='padding:8px 12px; border-bottom:1px solid #e7ebf0;'>
          " . htmlspecialchars($a['title'], ENT_QUOTES, 'UTF-8') . "
        </td>
        <td style='padding:8px 12px; border-bottom:1px solid #e7ebf0; color:#5f6775; font-size:13px;'>
          " . htmlspecialchars($a['body'], ENT_QUOTES, 'UTF-8') . "
        </td>
      </tr>";
  }

  return "
<html><body style='font-family:Segoe UI,Hiragino Sans,sans-serif; background:#f7f8fa; margin:0; padding:20px;'>
<div style='max-width:600px; margin:0 auto; background:#fff; border:1px solid #e7ebf0; border-radius:8px; padding:32px;'>

  <h1 style='font-size:18px; color:#2f3441; margin:0 0 16px;'>遅延アラート通知</h1>
  <p style='color:#5f6775; font-size:14px; margin:0 0 24px;'>
    プロジェクト <strong style='color:#2f3441;'>" . htmlspecialchars($projectName, ENT_QUOTES, 'UTF-8') . "</strong>
    の遅延タスクをお知らせします。<br>
    対象日: $today
  </p>

  <table style='width:100%; border-collapse:collapse; font-size:14px;'>
    <thead>
      <tr style='background:#fafbfc;'>
        <th style='padding:10px 12px; text-align:left; border-bottom:2px solid #e7ebf0; color:#5f6775; font-size:13px;'>タスク</th>
        <th style='padding:10px 12px; text-align:left; border-bottom:2px solid #e7ebf0; color:#5f6775; font-size:13px;'>詳細</th>
      </tr>
    </thead>
    <tbody>$alertRows</tbody>
  </table>

  <div style='margin-top:32px; padding-top:24px; border-top:1px solid #e7ebf0;'>
    <a href='$ganttUrl'
       style='display:inline-block; padding:12px 24px; background:#3457d5; color:#fff; text-decoration:none; border-radius:6px; font-weight:600;'>
      ガントチャートを開く
    </a>
  </div>

  <p style='margin-top:24px; color:#8a93a3; font-size:12px;'>
    このメールはガントチャートの遅延アラート通知システムから自動送信されています。<br>
    プロジェクトの通知設定でメール通知をOFFにすることで配信を停止できます。
  </p>
</div>
</body></html>";
}

function buildDigestText(string $projectName, string $projectId, array $alerts, string $today): string
{
  $baseUrl = getenv('WEBGANTT_MAIL_APP_BASE_URL') ?: 'https://ogma.mydns.jp/WebGantt';
  $ganttUrl = $baseUrl . '/gantt/gantt-collab.html?project=' . urlencode($projectId);

  $lines = [];
  $lines[] = "遅延アラート通知";
  $lines[] = "プロジェクト: $projectName";
  $lines[] = "対象日: $today";
  $lines[] = "";
  $lines[] = "■遅延タスク一覧:";

  foreach ($alerts as $a) {
    $lines[] = "  ・" . $a['title'];
    $lines[] = "    " . $a['body'];
    $lines[] = "";
  }

  $lines[] = "ガントチャートを開く:";
  $lines[] = $ganttUrl;
  $lines[] = "";
  $lines[] = "--";
  $lines[] = "このメールはガントチャートの遅延アラート通知システムから自動送信されています。";
  $lines[] = "プロジェクトの通知設定でメール通知をOFFにすることで配信を停止できます。";

  return implode("\n", $lines);
}
