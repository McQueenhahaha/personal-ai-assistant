import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFromCwd } from "../env.mjs";
import { sendTelegramMessage } from "../telegram.mjs";
import { readCodeVersion } from "../version.mjs";
import { readPeerCodeVersion } from "./soul-sync.mjs";
import { resolveNodeId, resolvePeerConnection } from "./supervisor.mjs";

// Mac 的代码只在手动跑 deploy-mac-brain.ps1 时才更新，平时没人想得起来。
// 2026-10-04 发现 Mac 的 http.mjs 还停在 08-02，29 个文件与 Windows 不同 ——
// 一旦大脑落到 Mac，跑的就是两个月前的代码。所以由看门狗定期比一次版本。
const STATE_FILE = "./data/state/peer-version.json";

export function readPeerVersionState(file = resolveFromCwd(STATE_FILE)) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 只在「一致 ↔ 不一致」转移时发：开发期间每提交一次本机版本就变一次，
// 若按版本号去重，每个提交都会多一条告警。
export function nextVersionAlert(previous, current) {
  if (previous?.match === current.match) return null;
  if (!current.match) {
    return `⚠️ Mac 大脑代码（${current.mac ?? "未知：旧部署没有 VERSION"}）与 Windows（${current.local}）不一致，`
      + "大脑落到 Mac 时会跑旧代码。在 Windows 上运行 scripts/deploy-mac-brain.ps1 同步。";
  }
  return previous ? `✅ Mac 大脑代码已与 Windows 一致（${current.local}）。` : null;
}

export async function checkPeerVersion({ nowMs }, dependencies = {}) {
  const env = dependencies.env || process.env;
  const selfId = resolveNodeId(env, dependencies.platform || process.platform);
  const peerConnection = dependencies.peerConnection !== undefined
    ? dependencies.peerConnection
    : resolvePeerConnection(selfId, env, os.homedir());
  if (!peerConnection) return { checked: false };

  const local = await (dependencies.readLocalVersion || readCodeVersion)();
  if (!local) return { checked: false };
  // Mac 不可达时这里会抛出，由看门狗记日志；不改动上次的判定。
  const mac = await (dependencies.readPeerVersion || readPeerCodeVersion)(peerConnection);
  const current = { local, mac, match: mac === local };

  const stateFile = dependencies.stateFile || resolveFromCwd(STATE_FILE);
  const alert = nextVersionAlert(readPeerVersionState(stateFile), current);
  if (alert) {
    const result = await (dependencies.sendTelegramMessage || sendTelegramMessage)(alert);
    // 不落盘：下一轮还会再试。
    if (!result?.sent) return { checked: true, match: current.match, alerted: false };
  }

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ ...current, atMs: nowMs })}\n`, "utf8");
  return { checked: true, match: current.match, alerted: Boolean(alert) };
}
