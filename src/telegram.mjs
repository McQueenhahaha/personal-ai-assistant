import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requestJson } from "./telegram/http.mjs";

const TELEGRAM_LIMIT = 3900;

function splitMessage(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > TELEGRAM_LIMIT) {
    const slice = remaining.slice(0, TELEGRAM_LIMIT);
    const splitAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
    const cut = splitAt > 1000 ? splitAt + 1 : TELEGRAM_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram token/chat ID missing. Digest output follows:\n");
    console.log(text);
    return { sent: false, reason: "missing Telegram config" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  for (const chunk of splitMessage(text)) {
    const response = await requestJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: false
      }
    });

    if (!response.ok) throw new Error("Telegram sendMessage returned ok=false");
  }

  return { sent: true };
}

export async function sendTelegramDocument(filePath, caption = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log("Telegram token/chat ID missing. Document not sent.");
    return { sent: false, reason: "missing Telegram config" };
  }

  const boundary = `----personal-ai-assistant-${randomUUID()}`;
  const parts = [];
  const appendField = (name, value) => {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  };
  appendField("chat_id", chatId);
  if (caption) appendField("caption", caption.slice(0, 1000));
  const filename = path.basename(filePath).replace(/[\r\n"]/g, "_");
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n`
      + "Content-Type: application/octet-stream\r\n\r\n"
  ));
  parts.push(fs.readFileSync(filePath));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const response = await requestJson(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts)
  });

  if (!response.ok) throw new Error("Telegram sendDocument returned ok=false");

  return { sent: true };
}
