const GET_UPDATES_URL = "https://api.telegram.org";

export function parseUpdates(updates) {
  const messages = [];
  for (const update of Array.isArray(updates) ? updates : []) {
    const message = update?.message;
    if (!message?.message_id || !message?.text) continue;
    messages.push({
      key: `${message.chat?.id || "chat"}:${message.message_id}`,
      chatId: String(message.chat?.id || ""),
      messageId: message.message_id,
      date: message.date || 0,
      text: message.text
    });
  }
  return messages.sort((a, b) => (a.date - b.date) || (a.messageId - b.messageId));
}

export function nextOffset(updates, currentOffset) {
  let maximumUpdateId = null;
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!Number.isInteger(update?.update_id)) continue;
    maximumUpdateId = maximumUpdateId == null
      ? update.update_id
      : Math.max(maximumUpdateId, update.update_id);
  }
  return maximumUpdateId == null ? currentOffset : maximumUpdateId + 1;
}

export async function fetchUpdates({ token, offset, timeoutSeconds = 25, fetchImpl = fetch }) {
  const query = new URLSearchParams({
    offset: String(offset),
    timeout: String(timeoutSeconds),
    allowed_updates: JSON.stringify(["message"])
  });
  const response = await fetchImpl(`${GET_UPDATES_URL}/bot${token}/getUpdates?${query}`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram getUpdates failed ${response.status}: ${body}`);
  }

  const json = await response.json();
  if (!json.ok || !Array.isArray(json.result)) {
    throw new Error("Telegram getUpdates returned an invalid response");
  }
  return json.result;
}
