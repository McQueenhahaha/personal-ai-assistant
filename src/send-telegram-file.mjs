import fs from "node:fs";
import { loadEnv } from "./env.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

loadEnv();

const file = process.argv[2];
if (!file) {
  console.error("Usage: node ./src/send-telegram-file.mjs <file>");
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");
await sendTelegramMessage(text);
