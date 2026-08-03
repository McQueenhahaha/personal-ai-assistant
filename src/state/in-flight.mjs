import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../env.mjs";

/**
 * 「正在做什么」的跨机可见记录 —— 凤凰计划的第一半。
 *
 * 解决的问题（用户提出）：
 * 心跳只能告诉对端"我还活着/我死了"，说不出"我做到哪一步了"。
 * 一台大脑在处理任务时死掉，任务文件躺在死者的 processing/ 里，
 * 而 data/queues/** 不在灵魂包清单里 —— 接管方完全不知道它存在过。
 * 用户只会看到"任务已开始"然后永远没有下文。这正是本仓反复消灭的静默丢失。
 *
 * 做法：把一条**极小的**记录写进灵魂包，跟着已有的同步节奏走，额外成本几乎为零。
 * 明确不做的事：不复制中间产物。codex 写了一半的代码是拿不回来的，
 * 要做到那样得流式复制，代价远超收益。
 * 能拿回来的是「知道什么被中断了」—— 它把静默丢失变成可见事件，这才是价值所在。
 */

export const IN_FLIGHT_RELATIVE = "data/state/in-flight.json";

export function inFlightFile(root = projectRoot()) {
  return path.join(root, IN_FLIGHT_RELATIVE);
}

/** 读不出来一律当作"没有在飞的任务"，绝不因此让 worker 起不来。 */
export function readInFlight(root = projectRoot(), fsImpl = fs) {
  try {
    const parsed = JSON.parse(String(fsImpl.readFileSync(inFlightFile(root), "utf8")).replace(/^﻿/, ""));
    if (!parsed || typeof parsed !== "object") return null;
    return typeof parsed.taskId === "string" && parsed.taskId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeInFlight({ taskId, title, taskType, nodeId, startedAt }, root = projectRoot(), fsImpl = fs) {
  const file = inFlightFile(root);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    taskId: String(taskId || ""),
    title: String(title || "").slice(0, 120),
    taskType: String(taskType || ""),
    nodeId: String(nodeId || ""),
    startedAt: String(startedAt || new Date().toISOString())
  };
  fsImpl.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/** 用"内容置空"而不是删文件：该文件在灵魂包里，而同步只搬运存在的文件、
 *  删除不传播 —— 靠删文件表示"做完了"的话，对端会永远以为还有任务在飞。 */
export function clearInFlight(root = projectRoot(), fsImpl = fs) {
  const file = inFlightFile(root);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify({ taskId: "" }, null, 2)}\n`, "utf8");
}

/**
 * 纯函数：判断这条记录是否代表"别的机器留下的、被中断的任务"。
 * 只有确定是别人留下的才算 —— 本机自己的在飞任务由本地的 processing/ 恢复流程处理，
 * 两边都报会让用户收到重复通知。
 */
export function describeInterrupted({ record, selfId, nowMs }) {
  if (!record?.taskId) return null;
  if (!record.nodeId || record.nodeId === selfId) return null;

  const startedMs = Date.parse(record.startedAt);
  const ranSeconds = Number.isFinite(startedMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.round((nowMs - startedMs) / 1000))
    : null;
  const label = record.nodeId === "mac" ? "MacBook" : record.nodeId === "windows" ? "Windows" : record.nodeId;
  const ranText = ranSeconds === null
    ? ""
    : ranSeconds >= 60
      ? `，已运行约 ${Math.round(ranSeconds / 60)} 分钟`
      : `，已运行约 ${ranSeconds} 秒`;

  return {
    taskId: record.taskId,
    fromNode: record.nodeId,
    taskType: record.taskType || "",
    text: `⚠️ ${label} 在处理《${record.title || record.taskId}》时中断了${ranText}。`
  };
}
