import { sendTelegramMessage } from "../telegram.mjs";

export async function sendOrPrint(text, dryRun, { send = sendTelegramMessage, log = console.log } = {}) {
  if (dryRun) {
    log(text);
    return;
  }
  await send(text);
}
