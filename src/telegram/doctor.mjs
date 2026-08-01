import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { loadEnv, resolveFromCwd } from "../env.mjs";
import { requestJson } from "./http.mjs";

const OFFSET_FILE = "./data/state/telegram-update-offset.json";
const HEARTBEAT_FILE = "./data/state/telegram-direct-heartbeat.json";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function inspectJsonFile(label, file) {
  console.log(`${label} 文件：${file}`);
  if (!fs.existsSync(file)) {
    console.log(`${label} 内容：(不存在)`);
    return null;
  }

  const content = fs.readFileSync(file, "utf8").trim();
  console.log(`${label} 内容：${content || "(空文件)"}`);
  try {
    return JSON.parse(content);
  } catch {
    console.log(`${label} 状态：JSON 无效`);
    return null;
  }
}

function formatAge(ageMs) {
  if (ageMs < 0) return `时间在未来 ${Math.abs(ageMs)} 毫秒`;
  if (ageMs < 1000) return `${ageMs} 毫秒`;
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)} 秒`;
  if (ageMs < 3_600_000) return `${(ageMs / 60_000).toFixed(1)} 分钟`;
  return `${(ageMs / 3_600_000).toFixed(1)} 小时`;
}

async function printWebhookInfo(token) {
  if (!token) {
    console.log("Webhook 检查：缺少 TELEGRAM_BOT_TOKEN，无法调用 getWebhookInfo");
    process.exitCode = 1;
    return;
  }

  try {
    const body = await requestJson(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    if (!body.ok || !body.result) {
      throw new Error("Telegram getWebhookInfo 返回无效响应");
    }
    console.log(`pending_update_count：${body.result.pending_update_count ?? 0}`);
    console.log(`webhook url：${body.result.url || "(空)"}`);
  } catch (error) {
    console.log(`Webhook 检查失败：${error.message || String(error)}`);
    process.exitCode = 1;
  }
}

async function printNetworkCheck(token) {
  if (!token) {
    console.log("Telegram 网络自检：跳过（缺少 TELEGRAM_BOT_TOKEN）");
    return;
  }

  const startedAt = Date.now();
  try {
    const body = await requestJson(`https://api.telegram.org/bot${token}/getMe`);
    if (!body.ok || !body.result) {
      throw new Error("Telegram getMe 返回无效响应");
    }
    console.log(`Telegram 网络自检：成功（getMe，${Date.now() - startedAt} ms）`);
  } catch (error) {
    console.log(`Telegram 网络自检：失败（getMe，${Date.now() - startedAt} ms）：${error.message || String(error)}`);
    console.log("提示：可能是到 Telegram 的 IPv6 路由不通，请尝试 TELEGRAM_IP_FAMILY=4");
    process.exitCode = 1;
  }
}

function printBridgeProcesses() {
  if (process.platform !== "win32") {
    console.log("桥进程检查：当前平台非 Windows，已跳过");
    return;
  }

  const options = {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  };
  const wmic = spawnSync("wmic.exe", [
    "process",
    "where",
    "name='node.exe'",
    "get",
    "CommandLine,ProcessId",
    "/format:csv"
  ], options);

  let processIds;
  if (!wmic.error && wmic.status === 0) {
    processIds = wmic.stdout
      .split(/\r?\n/)
      .filter((line) => /openclaw-telegram-bridge\.mjs/i.test(line))
      .map((line) => Number(line.match(/,(\d+)\s*$/)?.[1]))
      .filter(Number.isInteger);
  } else {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match 'openclaw-telegram-bridge\\.mjs' } | Select-Object ProcessId)",
      "$items | ConvertTo-Json -Compress"
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], options);

    if (result.error || result.status !== 0) {
      const detail = result.error?.message || result.stderr.trim() || `退出码 ${result.status}`;
      console.log(`桥进程检查失败：${detail}`);
      process.exitCode = 1;
      return;
    }

    try {
      const output = result.stdout.trim();
      const parsed = output ? JSON.parse(output) : [];
      const processes = Array.isArray(parsed) ? parsed : [parsed];
      processIds = processes.map((item) => item.ProcessId).filter(Number.isInteger);
    } catch (error) {
      console.log(`桥进程检查失败：无法解析进程查询结果（${error.message || String(error)}）`);
      process.exitCode = 1;
      return;
    }
  }

  processIds = [...new Set(processIds)];
  console.log(`桥进程数量：${processIds.length}`);
  console.log(`桥进程 PID：${processIds.length > 0 ? processIds.join(", ") : "(无)"}`);
  if (processIds.length > 1) {
    console.log("[警告] 检测到多个 OpenClaw Telegram 桥进程");
  }
}

async function main() {
  loadEnv();
  const directMode = boolEnv("TELEGRAM_DIRECT_MODE", false);
  console.log(`当前模式：${directMode ? "Telegram 直连模式" : "OpenClaw 文件模式"}`);

  const offset = inspectJsonFile("offset", resolveFromCwd(OFFSET_FILE));
  const heartbeat = inspectJsonFile("心跳", resolveFromCwd(HEARTBEAT_FILE));
  if (Number.isFinite(heartbeat?.atMs)) {
    console.log(`心跳距今：${formatAge(Date.now() - heartbeat.atMs)}`);
  } else {
    console.log("心跳距今：(无法计算)");
  }
  if (offset && !Number.isInteger(offset.offset)) {
    console.log("offset 状态：缺少有效整数 offset");
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  await printNetworkCheck(token);
  await printWebhookInfo(token);
  printBridgeProcesses();
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
