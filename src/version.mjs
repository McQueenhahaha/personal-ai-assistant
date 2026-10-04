import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 在进程启动时调用并缓存：/status 要回答「正在跑的是哪一版」，而不是磁盘上
// 现在是哪一版 —— 改了代码没重启时，两者不一样。异步执行，免得卡住事件循环。
export async function readCodeVersion({ cwd = process.cwd(), execFileImpl = execFileAsync } = {}) {
  const options = { cwd, timeout: 3000, windowsHide: true };
  try {
    const { stdout: head } = await execFileImpl("git", ["rev-parse", "--short", "HEAD"], options);
    const { stdout: changes } = await execFileImpl("git", ["status", "--porcelain", "--untracked-files=no"], options);
    return `${head.trim()}${changes.trim() ? "（含未提交改动）" : ""}`;
  } catch {
    // 不是 git 检出（如 Mac 的 ~/pai-brain）或没装 git。
    return null;
  }
}
