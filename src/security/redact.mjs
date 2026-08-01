export function redactSensitive(text) {
  return String(text || "")
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[TELEGRAM_BOT_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[GOOGLE_API_KEY]")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]+\b/g, "[GOOGLE_CLIENT_SECRET]")
    .replace(/\bya29\.[0-9A-Za-z._-]+\b/g, "[GOOGLE_ACCESS_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[OPENAI_API_KEY]")
    .replace(/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, "[OPENAI_API_KEY]")
    .replace(/\b\d+~[A-Za-z0-9]{20,}\b/g, "[CANVAS_API_TOKEN]")
    .replace(
      /(\\?"(?:client_secret|refresh_token|access_token|id_token|api_key|token|password|pass|cookie|secret)\\?"\s*:\s*\\?")[^"\\]+(\\?")/gi,
      "$1[REDACTED]$2"
    )
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(TOKEN|KEY|SECRET|PASSWORD|PASS|COOKIE)\s*=\s*["']?[^"'\s;]+/gi, "$1=[REDACTED]");
}
