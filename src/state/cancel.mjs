import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../env.mjs";

/**
 * 「取消当前任务」的一次性信号。
 *
 * 与 pause.mjs 的分工：
 *   /stop    全停 —— 中断正在跑的，并且**一直停着**，直到 /resume。
 *            那是出事时的锤子。
 *   /cancel  只掐当前这一个任务，助手继续运行、继续领下一个。
 *
 * 做成独立文件而不是给 pause 的 level 加一档：level 是**持久状态**
 * （none/pause/stop 会一直保持），而取消是**一次性事件** —— 用完即清。
 * 两者混在一起的话，"取消完要不要自动回到 none" 会变成一个说不清的问题。
 *
 * 沿用 pause.mjs 的"内容表示状态"而非"文件存在即取消"：taskId 为空串就是
 * 没有待取消的任务。理由同上——万一将来这个文件要跨机同步，删除是不传播的。
 *
 * 刻意**不**进灵魂包：取消是即时动作，隔一台机器再执行已经没有意义，
 * 反而会在接管后掐掉一个不相干的新任务。
 */

export const CANCEL_REQUEST_RELATIVE = "data/state/cancel-request.json";

export function cancelRequestFile(root = projectRoot()) {
  return path.join(root, CANCEL_REQUEST_RELATIVE);
}

/** 读不出就当作"没有取消请求" —— 读不出状态时让任务继续跑，
 *  比因为读不出就把用户的活掐掉要安全。*/
export function readCancelRequest(root = projectRoot(), fsImpl = fs) {
  try {
    const raw = fsImpl.readFileSync(cancelRequestFile(root), "utf8");
    const parsed = JSON.parse(String(raw).replace(/^﻿/, ""));
    return {
      taskId: typeof parsed?.taskId === "string" ? parsed.taskId : "",
      at: typeof parsed?.at === "string" ? parsed.at : ""
    };
  } catch {
    return { taskId: "", at: "" };
  }
}

export function requestCancel(taskId, root = projectRoot(), fsImpl = fs, now = new Date()) {
  const file = cancelRequestFile(root);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { taskId: String(taskId || ""), at: now.toISOString() };
  fsImpl.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/** 用内容置空表示"已消费"，不删文件（理由见文件头）。*/
export function clearCancelRequest(root = projectRoot(), fsImpl = fs) {
  const file = cancelRequestFile(root);
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${JSON.stringify({ taskId: "", at: "" }, null, 2)}\n`, "utf8");
}

/**
 * 当前正在执行的这个任务是否被点名取消。
 *
 * 只认**指名道姓**的取消：taskId 必须与正在跑的一致。空的 taskId 一律不算 ——
 * 否则一条陈旧的取消请求会把之后随便哪个新任务掐掉，而用户完全不知道为什么。
 */
export function isCancelRequestedFor(taskId, root = projectRoot(), fsImpl = fs) {
  const wanted = String(taskId || "");
  if (!wanted) return false;
  return readCancelRequest(root, fsImpl).taskId === wanted;
}
