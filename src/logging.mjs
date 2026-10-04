import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

// Windows 上 stdout/stderr 原先由 PowerShell 5.1 重定向落盘：编码按控制台代码页
// 解码再写成 UTF-16，中文乱码、grep 不动；stderr 每行还被包成 NativeCommandError；
// 行内也没有时间戳，事后对不上时间线。改由进程自己写 UTF-8 JSONL。
const METHOD_LEVELS = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" };

// supervisor 的 logMessage 等旧代码自带「[ISO] LEVEL 」前缀；记录里已有 at/level，
// 剥掉前缀免得时间写两遍，并以前缀里的级别为准（它们都走 console.log）。
const LEGACY_PREFIX = /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] (DEBUG|INFO|WARN|ERROR) /;

export function formatLogLine(level, args, now = new Date()) {
  let msg = format(...args);
  const legacy = LEGACY_PREFIX.exec(msg);
  if (legacy) {
    level = legacy[1].toLowerCase();
    msg = msg.slice(legacy[0].length);
  }
  return `${JSON.stringify({ at: now.toISOString(), level, msg })}\n`;
}

function rotatedPath(filePath) {
  const ext = path.extname(filePath);
  return path.join(path.dirname(filePath), `${path.basename(filePath, ext)}.1${ext}`);
}

// 接管 console.* 之后不再写 stdout/stderr：启动脚本的重定向只剩下 node 自身
// 打印的未捕获异常和原生崩溃，正好作为 JSONL 之外的兜底。
export function installFileLogging(filePath, { maxBytes = 5 * 1024 * 1024, target = console } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // 文件还不存在：从 0 开始计。
  }

  for (const [method, level] of Object.entries(METHOD_LEVELS)) {
    target[method] = (...args) => {
      const line = formatLogLine(level, args);
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        fs.rmSync(rotatedPath(filePath), { force: true });
        fs.renameSync(filePath, rotatedPath(filePath));
        size = 0;
      }
      fs.appendFileSync(filePath, line, "utf8");
      size += bytes;
    };
  }
}
