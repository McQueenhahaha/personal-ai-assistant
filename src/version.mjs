import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 在进程启动时调用并缓存：/status 要回答「正在跑的是哪一版」，而不是磁盘上
// 现在是哪一版 —— 改了代码没重启时，两者不一样。异步执行，免得卡住事件循环。
export async function readCodeVersion({
  cwd = process.cwd(),
  execFileImpl = execFileAsync,
  readFileImpl = readFile
} = {}) {
  // Mac 的 ~/pai-brain 不是 git 检出，版本号由 deploy-mac-brain.ps1 写进 VERSION。
  // 先读它，免得在 Mac 上调 /usr/bin/git —— 没装开发者工具时那是个会弹窗的占位程序。
  try {
    const deployed = (await readFileImpl(path.join(cwd, "VERSION"), "utf8")).trim();
    if (deployed) return deployed;
  } catch {
    // 没有 VERSION：Windows 的 git 检出，走下面。
  }
  const options = { cwd, timeout: 3000, windowsHide: true };
  try {
    const { stdout: head } = await execFileImpl("git", ["rev-parse", "--short", "HEAD"], options);
    const { stdout: changes } = await execFileImpl("git", ["status", "--porcelain", "--untracked-files=no"], options);
    return `${head.trim()}${changes.trim() ? "（含未提交改动）" : ""}`;
  } catch {
    // 不是 git 检出又没有 VERSION（旧部署），或没装 git。
    return null;
  }
}

// deploy-mac-brain.ps1 用它生成 Mac 的 VERSION，保证两端版本号是同一套格式。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await readCodeVersion({ cwd: fileURLToPath(new URL("..", import.meta.url)) }) ?? "");
}
