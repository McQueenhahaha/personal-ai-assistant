import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, projectRoot } from "../env.mjs";

/**
 * Gmail 快照导出。原先是 scripts/export-gmail-mail.ps1。
 *
 * 搬到 Node 的唯一理由：大脑会漂到 Mac，而 Mac 上没有 PowerShell。
 * 之前的后果是"检查静默不执行" —— 不报错，只是什么都不发生。
 *
 * 真正干活的始终是 gog（跨平台 Go CLI；Windows 由 openclaw-env.ps1 把
 * D:\AI\gogcli 加进 PATH，Mac 用 brew install gogcli）。本文件只负责拼参数、
 * 跑它、把结果写成 data/personal-mail-drop 下的快照。
 *
 * 原脚本 157 行里有 36 行在手工做 Windows 命令行转义（ConvertTo-ProcessArgument）：
 * 因为 ProcessStartInfo.Arguments 只收单个字符串，query 必须自己转义。
 * Node 的 spawn 收 argv 数组，那段整个消失，query 也就不可能被拆成命令。
 *
 * 输出格式与原脚本保持一致。BOM 与 CRLF 没有保留 —— 已实测解析器用
 * /\r?\n/ 切行，带 BOM+CRLF 与不带的两份快照解析结果完全相同。
 */

export const DEFAULT_QUERY =
  "in:inbox newer_than:7d -category:promotions -category:social -in:drafts";

export const DEFAULT_MAX_MESSAGES = 30;

// gog 把翻页提示写在 stderr，那不是错误，不该当成警告报给用户。
// 两种写法都要认：Windows 那台是 gog v0.16.0（"# Next page:"），
// Mac 是 brew 装的 0.34.2（"# More results:"）。两边版本差 18 个小版本，
// 但 --plain 的六列格式没变（已实测两边产物列头一致），只有这句提示改了措辞。
const PAGINATION_HINT = /^\s*#\s*(Next page|More results)\b/;

export function buildGogArgs({ query, maxMessages, account }) {
  const args = [
    "gmail",
    "search",
    query,
    "--max",
    String(maxMessages),
    "--plain",
    "--gmail-no-send"
  ];
  if (account) args.push("--account", account);
  return args;
}

/** 时间戳只用于文件名，冒号在 Windows 上非法，故与原脚本一样用横杠。 */
export function snapshotStamp(now) {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

export function renderSnapshot({ query, maxMessages, account, output, now }) {
  return [
    "Subject: Gmail snapshot",
    "From: gog gmail",
    `Date: ${now.toISOString()}`,
    "",
    "# Gmail snapshot",
    "",
    `- Query: ${query}`,
    `- Max messages: ${maxMessages}`,
    `- Account: ${account}`,
    "",
    "```text",
    ...output,
    "```",
    ""
  ].join("\n");
}

export function exportGmailSnapshot(options = {}, dependencies = {}) {
  const spawn = dependencies.spawn || spawnSync;
  const env = dependencies.env || process.env;
  const fsImpl = dependencies.fs || fs;
  const root = dependencies.root || projectRoot();
  const now = dependencies.now ? dependencies.now() : new Date();

  const query = options.query || DEFAULT_QUERY;
  const maxMessages = Number(options.maxMessages) > 0
    ? Number(options.maxMessages)
    : DEFAULT_MAX_MESSAGES;
  const account = options.account || env.GOG_ACCOUNT || "";
  const outDir = options.outDir || path.join(root, "data", "personal-mail-drop");

  const result = spawn("gog", buildGogArgs({ query, maxMessages, account }), {
    encoding: "utf8"
  });

  if (result.error) {
    throw new Error(
      result.error.code === "ENOENT"
        ? "找不到 gog：Windows 靠 openclaw-env.ps1 把 D:\\AI\\gogcli 加进 PATH，Mac 用 brew install gogcli"
        : `gog 启动失败：${result.error.message}`
    );
  }

  // 末尾换行会多切出一个空元素，去掉它才能和原来 Get-Content 的行为一致。
  const stdout = String(result.stdout || "").replace(/\r?\n$/, "");
  const output = stdout ? stdout.split(/\r?\n/) : [];
  const warnings = String(result.stderr || "")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !PAGINATION_HINT.test(line));

  if (result.status !== 0) {
    throw new Error(`gog Gmail export failed: ${[...warnings, ...output].join("\n").trim()}`);
  }

  fsImpl.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `gmail-snapshot-${snapshotStamp(now)}.md`);
  fsImpl.writeFileSync(
    outFile,
    renderSnapshot({ query, maxMessages, account, output, now }),
    "utf8"
  );

  return { outFile, warnings, message: `Exported Gmail snapshot to ${outFile}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEnv();
  try {
    const result = exportGmailSnapshot();
    for (const warning of result.warnings.slice(0, 5)) console.warn(warning);
    process.stdout.write(`${result.message}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
