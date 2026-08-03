import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../env.mjs";

/**
 * 暂停/急停状态的单一真源。
 *
 * 为什么是"永远存在的 JSON"而不是"存在即暂停的标志文件"：
 * 灵魂包同步(src/brain/soul-sync.mjs)只搬运**存在的**文件，删除不会传播；
 * 而且 pullSoul 对每个文件都做 JSON.parse。用标志文件的话会出现：
 *   在 Windows 按 /stop -> 标志同步到 Mac -> 在 Windows 按 /resume(删文件)
 *   -> 删除不传播 -> Mac 上标志还在 -> 大脑迁过去，助手又静默停了。
 * 那比不同步更糟。把状态放进内容里，"恢复"就变成一次普通的内容更新。
 *
 * level 语义：
 *   none   正常运行
 *   pause  不再领取新任务(定时摘要/检查也跳过)，但不打断正在跑的
 *   stop   在 pause 基础上，额外中断正在执行的任务
 */

export const PAUSE_STATE_RELATIVE = "data/state/assistant-pause-state.json";
export const LEVELS = Object.freeze(["none", "pause", "stop"]);

export function pauseStateFile(root = projectRoot()) {
  return path.join(root, PAUSE_STATE_RELATIVE);
}

/** 任何异常都退化为"正常运行" —— 读不出状态时让助手继续工作，
 *  比因为读不出来就罢工要安全（罢工是静默的，用户无从察觉）。*/
export function readPauseState(root = projectRoot(), fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(pauseStateFile(root), "utf8");
    const parsed = JSON.parse(String(raw).replace(/^﻿/, ""));
    const level = LEVELS.includes(parsed?.level) ? parsed.level : "none";
    return { level, at: typeof parsed?.at === "string" ? parsed.at : "" };
  } catch {
    return { level: "none", at: "" };
  }
}

export function writePauseState(level, root = projectRoot(), fsImpl = fs, now = new Date()) {
  if (!LEVELS.includes(level)) throw new Error(`未知的暂停级别：${level}`);
  const file = pauseStateFile(root);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { level, at: level === "none" ? "" : now.toISOString() };
  fsImpl.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/** 是否应当跳过自动处理（pause 与 stop 都算）。*/
export function isPaused(root = projectRoot(), fsImpl = fs) {
  return readPauseState(root, fsImpl).level !== "none";
}

/** 是否应当中断正在执行的任务（只有 stop 算）。*/
export function isStopRequested(root = projectRoot(), fsImpl = fs) {
  return readPauseState(root, fsImpl).level === "stop";
}
