import fs from "node:fs";
import path from "node:path";
import { formatConfigReport, reportConfig } from "./config-doctor.mjs";
import { buildDigest } from "./openai.mjs";
import { collectMailDrops } from "./mail-drop.mjs";
import { envList, envNumber, loadEnv, resolveFromCwd, timestampForFile } from "./env.mjs";
import { fetchGameNews } from "./rss.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

async function runDigest() {
  loadEnv();
  if (fs.existsSync(resolveFromCwd("./data/state/assistant-paused.flag"))) {
    console.log("[digest] 已暂停(assistant-paused.flag), 跳过本次。");
    return;
  }

  console.log(formatConfigReport(reportConfig()));

  const title = process.env.DIGEST_TITLE || "Daily personal AI digest";
  const queries = envList("GAME_QUERIES", ["gaming news", "Steam game updates"]);
  const excludeTerms = envList("GAME_NEWS_EXCLUDE_TERMS", []);
  const locale = process.env.GAME_NEWS_LOCALE || "en-AU";
  const ceid = process.env.GAME_NEWS_CEID || "AU:en";
  const maxPerQuery = envNumber("GAME_NEWS_MAX_PER_QUERY", 4);
  const mailMaxFiles = envNumber("MAIL_DROP_MAX_FILES", 20);

  let gameNews;
  try {
    gameNews = await fetchGameNews({
      queries,
      excludeTerms,
      maxPerQuery,
      locale,
      ceid
    });
  } catch (err) {
    console.warn("[digest] 游戏资讯获取失败，本次跳过：" + (err?.message || err));
    gameNews = [];
  }

  let mailMessages;
  try {
    mailMessages = collectMailDrops({
      schoolDir: process.env.SCHOOL_MAIL_DROP_DIR || "./data/school-mail-drop",
      personalDir: process.env.PERSONAL_MAIL_DROP_DIR || "./data/personal-mail-drop",
      maxFiles: mailMaxFiles
    });
  } catch (err) {
    console.warn("[digest] 邮件获取失败，本次跳过：" + (err?.message || err));
    mailMessages = [];
  }

  const digest = await buildDigest({
    title,
    gameNews,
    mailMessages
  });

  const archiveDir = resolveFromCwd("./data/digest-archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, `${timestampForFile()}.txt`), digest, "utf8");

  await sendTelegramMessage(digest);
}

async function main() {
  const command = process.argv[2] || "digest";
  if (command !== "digest") {
    throw new Error(`Unknown command: ${command}`);
  }

  await runDigest();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
