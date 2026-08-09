<?php
/**
 * MailSender — 外部メールサービス(Brevo)経由のメール送信
 * Phase 5-9
 *
 * 2つの接続方式を環境変数 WEBGANTT_MAIL_PROVIDER で切り替え:
 *   - smtp (既定): PHPMailer + SMTPリレー smtp.brevo.com:587
 *   - api:         Brevo REST API (curl)
 *
 * どちらも同じ send() インターフェースを持つ。
 * config.php の getenv() パターンを踏襲。
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 takeda
 */

require_once __DIR__ . '/config.php';
// PHPMailer (composer で導入) — autoloader を読み込み
require_once __DIR__ . '/vendor/autoload.php';

class MailSender
{
  private string $provider;
  private ?string $lastError = null;

  public function __construct()
  {
    $this->provider = strtolower(getenv('WEBGANTT_MAIL_PROVIDER') ?: 'smtp');
  }

  /**
   * メール送信
   * @param string $to       宛先メールアドレス
   * @param string $subject  件名
   * @param string $htmlBody HTML本文
   * @param string $textBody プレーンテキスト本文(任意・空可)
   * @return bool 成功=true / 失敗=false(失敗時は getLastError() で原因)
   */
  public function send(string $to, string $subject, string $htmlBody, string $textBody = ''): bool
  {
    if ($this->provider === 'api') {
      return $this->sendViaApi($to, $subject, $htmlBody, $textBody);
    }
    return $this->sendViaSmtp($to, $subject, $htmlBody, $textBody);
  }

  public function getLastError(): ?string
  {
    return $this->lastError;
  }

  // ── SMTPリレー方式 ──────────────────────────────────
  private function sendViaSmtp(string $to, string $subject, string $htmlBody, string $textBody): bool
  {
    $smtpHost = getenv('WEBGANTT_SMTP_HOST') ?: 'smtp-relay.brevo.com';
    $smtpPort = (int)(getenv('WEBGANTT_SMTP_PORT') ?: 587);
    $smtpUser = getenv('WEBGANTT_SMTP_USER') ?: 'apikey';
    $smtpPass = getenv('WEBGANTT_SMTP_PASS') ?: '';
    $fromAddr = getenv('WEBGANTT_MAIL_FROM') ?: 'gantt@ogma.mydns.jp';
    $fromName = getenv('WEBGANTT_MAIL_FROM_NAME') ?: 'ガントチャート通知';

    if (!$smtpPass) {
      $this->lastError = 'WEBGANTT_SMTP_PASS が未設定';
      return false;
    }

    // PHPMailer(composer で導入済み)
    $mail = new PHPMailer\PHPMailer\PHPMailer(true);

    try {
      $mail->isSMTP();
      $mail->Host       = $smtpHost;
      $mail->Port       = $smtpPort;
      $mail->SMTPAuth   = true;
      $mail->Username   = $smtpUser;
      $mail->Password   = $smtpPass;
      $mail->SMTPSecure = PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS;
      $mail->CharSet    = 'UTF-8';

      $mail->setFrom($fromAddr, $fromName);
      $mail->addAddress($to);
      $mail->Subject = $subject;
      $mail->isHTML(true);
      $mail->Body    = $htmlBody;
      if ($textBody) $mail->AltBody = $textBody;

      $mail->send();
      return true;
    } catch (PHPMailer\PHPMailer\Exception $e) {
      $this->lastError = 'SMTP送信エラー: ' . $mail->ErrorInfo;
      return false;
    }
  }

  // ── REST API方式 ──────────────────────────────────────
  private function sendViaApi(string $to, string $subject, string $htmlBody, string $textBody): bool
  {
    $apiKey   = getenv('WEBGANTT_MAIL_API_KEY') ?: '';
    $fromAddr = getenv('WEBGANTT_MAIL_FROM') ?: 'gantt@ogma.mydns.jp';
    $fromName = getenv('WEBGANTT_MAIL_FROM_NAME') ?: 'ガントチャート通知';

    if (!$apiKey) {
      $this->lastError = 'WEBGANTT_MAIL_API_KEY が未設定';
      return false;
    }

    $payload = [
      'sender'      => ['email' => $fromAddr, 'name' => $fromName],
      'to'          => [['email' => $to]],
      'subject'     => $subject,
      'htmlContent' => $htmlBody,
    ];
    if ($textBody) $payload['textContent'] = $textBody;

    $ch = curl_init('https://api.brevo.com/v3/smtp/email');
    curl_setopt_array($ch, [
      CURLOPT_POST           => true,
      CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_HTTPHEADER     => [
        'accept: application/json',
        'content-type: application/json',
        'api-key: ' . $apiKey,
      ],
      CURLOPT_TIMEOUT        => 30,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr) {
      $this->lastError = 'API通信エラー: ' . $curlErr;
      return false;
    }
    if ($httpCode < 200 || $httpCode >= 300) {
      $this->lastError = "API応答エラー(HTTP $httpCode): $response";
      return false;
    }
    return true;
  }
}
