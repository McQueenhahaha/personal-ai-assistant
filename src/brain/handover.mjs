import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, projectRoot } from "../env.mjs";
import { resolveNodeId } from "./supervisor.mjs";
import { pushSoul } from "./soul-sync.mjs";

/**
 * 凤凰计划（二）：临终交接。
 *
 * 现有模型是"幸存者去尸体上取数据" —— 对端准备接管前先 pullSoul 拉走者的状态。
 * 但机器已经冻住/关机就拉不到，于是要么用旧数据、要么保守放弃接管。
 * 这里反过来：**将死者在还能动的时候主动把状态推出去**。
 *
 * 覆盖范围（有预警的死法）：睡眠/待机、计划关机、游戏模式挂起。
 * 不覆盖：蓝屏、断电 —— 物理上没有预警，只能靠既有的周期同步兜底。
 *
 * 刻意不改 decideRole：那是防脑裂的核心路径。这里只是把自己的租约写成
 * **已过期**（这在事实上就是真的——马上要睡了），对端下一轮按既有逻辑正常接管，
 * 不需要新的状态或分支。
 */

/** 纯函数：把租约标记为"我主动让出"。heartbeatAt 回拨到超过 TTL，
 *  于是对端用现成的过期判定就能立刻接管，无需等满 TTL。 */
export function makeReleasedLease(lease, nowMs) {
  const ttlSeconds = Number(lease?.ttlSeconds) > 0 ? Number(lease.ttlSeconds) : 90;
  return {
    ...lease,
    ttlSeconds,
    // 多回拨 1 秒，确保任何比较方式下都算过期
    heartbeatAt: new Date(nowMs - (ttlSeconds + 1) * 1000).toISOString(),
    reason: "handover",
    releasedAt: new Date(nowMs).toISOString()
  };
}

/** 只有"本机确实持有租约"才需要交接；否则什么都不做。 */
export function shouldHandOver({ lease, selfId }) {
  if (!lease || typeof lease !== "object") return { act: false, reason: "no-lease" };
  if (lease.holder !== selfId) return { act: false, reason: "not-brain" };
  if (lease.reason === "handover") return { act: false, reason: "already-released" };
  return { act: true, reason: "brain-departing" };
}

export async function runHandover(dependencies = {}) {
  const root = dependencies.root || projectRoot();
  const fsImpl = dependencies.fs || fs;
  const nowMs = dependencies.nowMs ?? Date.now();
  const selfId = dependencies.selfId || resolveNodeId();
  const leaseFile = path.join(root, "data", "state", "brain-lease.json");

  let lease = null;
  try {
    lease = JSON.parse(String(fsImpl.readFileSync(leaseFile, "utf8")).replace(/^﻿/, ""));
  } catch {
    lease = null;
  }

  const decision = shouldHandOver({ lease, selfId });
  if (!decision.act) return { handedOver: false, reason: decision.reason };

  // 先写本地：即使随后推送失败（对端不可达/来不及），本机也已经让出，
  // 醒来后会按正常流程重新竞争，不会出现"我以为自己还是大脑"的错位。
  const released = makeReleasedLease(lease, nowMs);
  fsImpl.writeFileSync(leaseFile, `${JSON.stringify(released, null, 2)}\n`, "utf8");

  const push = dependencies.pushSoul || pushSoul;
  // env 可注入：直接读 process.env 会让测试受开发机状态影响 ——
  // 本仓已经因为这类耦合出过一次"9 个无关测试因残留标志而失败"。
  const env = dependencies.env || process.env;
  const host = env[selfId === "windows" ? "MAC_SATELLITE_HOST" : "WINDOWS_SSH_HOST"] || "";
  const key = env[selfId === "windows" ? "MAC_SATELLITE_KEY" : "WINDOWS_SSH_KEY"] || "";
  if (!host || !key) return { handedOver: true, pushed: false, reason: "peer-not-configured" };

  try {
    await push({ host, key }, {
      backupTimestamp: new Date(nowMs).toISOString().replace(/[:.]/g, "-")
    });
    return { handedOver: true, pushed: true, reason: decision.reason };
  } catch (error) {
    // 推送失败不算失败：本机已让出，对端仍会在 TTL 到期后按既有逻辑接管，
    // 只是拿到的状态旧一些。这正是"有预警"与"无预警"之间的差别。
    return { handedOver: true, pushed: false, reason: `push-failed: ${error.message || String(error)}` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadEnv();
  runHandover()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ handedOver: false, reason: error.message || String(error) })}\n`);
      process.exitCode = 1;
    });
}
