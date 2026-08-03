import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, projectRoot } from "../env.mjs";
import { resolveNodeId } from "../brain/supervisor.mjs";

/**
 * 定时工作的归属判断：只有持有大脑租约的那台机器才该跑定时检查。
 *
 * 为什么需要它（2026-08-03 实测的真实故障）：
 * school-check-state.json / canvas-reminders-sent.json 都在灵魂包清单里。
 * 当大脑在另一台时，本机是待命节点，supervisor 每约 35 秒 pullSoul 一次、
 * 用对端副本覆盖本地状态。而定时检查若仍在本机运行，它刚存下的去重状态会在
 * 几十秒内被冲掉 —— 于是每次运行都判定"首次发送"，同一批内容反复推送。
 * 用户被同一批游戏资讯每 5 分钟刷屏过。
 *
 * 这条规则是**对称的**：无论大脑在 Windows 还是 Mac，非持有方都不该跑定时工作。
 */

export const SKIP = "skip";
export const RUN = "run";

/**
 * 纯函数，便于单测。
 * 只有"租约新鲜且持有者是别人"才跳过 —— 这正是会发生覆盖的那种情形。
 * 其余一律放行：无租约=单机模式；租约损坏=宁可多跑一次也不要静默停摆
 * （静默停摆用户无从察觉，是本仓反复消灭的那类故障）。
 */
export function decideScheduledWork({ lease, selfId, nowMs }) {
  if (!lease || typeof lease !== "object") {
    return { action: RUN, reason: "no-lease" };
  }
  const holder = typeof lease.holder === "string" ? lease.holder : "";
  if (!holder) return { action: RUN, reason: "lease-unreadable" };
  if (holder === selfId) return { action: RUN, reason: "self-holds-lease" };

  const heartbeat = Date.parse(lease.heartbeatAt);
  const ttlMs = Number(lease.ttlSeconds) * 1000;
  if (!Number.isFinite(heartbeat) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { action: RUN, reason: "lease-unreadable" };
  }
  if (nowMs - heartbeat > ttlMs) {
    // 租约已过期：对端多半已经死了，本机很可能即将接管，让它跑。
    return { action: RUN, reason: "peer-lease-expired" };
  }
  return { action: SKIP, reason: "peer-holds-lease" };
}

export function readLease(root = projectRoot(), fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(path.join(root, "data", "state", "brain-lease.json"), "utf8");
    return JSON.parse(String(raw).replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/**
 * CLI：退出码 0 = 本机该跑；1 = 本机该跳过。
 * 两个平台共用一份实现：
 *   PowerShell  & node .\src\state\brain-guard.mjs; if ($LASTEXITCODE -ne 0) { exit 0 }
 *   shell       node src/state/brain-guard.mjs || exit 0
 */
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // 必须先 loadEnv：resolveNodeId 依赖 BRAIN_NODE_ID，不加载 .env 会认错自己是哪台机器，
  // 从而把"该跑"判成"该跳过"（或反过来）。本仓 supervisor 曾因漏调它导致所有 .env
  // 配置不可见 —— 纯函数测试全绿但程序跑不起来，测试 guarded entrypoints 就是为此而立。
  loadEnv();
  const root = projectRoot();
  const decision = decideScheduledWork({
    lease: readLease(root),
    selfId: resolveNodeId(),
    nowMs: Date.now()
  });
  process.stdout.write(`${decision.action} ${decision.reason}\n`);
  process.exitCode = decision.action === RUN ? 0 : 1;
}
