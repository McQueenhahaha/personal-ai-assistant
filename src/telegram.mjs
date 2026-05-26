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
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: false
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram send failed ${response.status}: ${body}`);
    }
  }

  return { sent: true };
}
