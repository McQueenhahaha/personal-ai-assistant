import { spawn } from "node:child_process";

function trimError(text, maxLength = 300) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
}

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function spawnClaude(cliPath, args) {
  if (process.platform !== "win32") {
    return spawn(cliPath, args, {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  }

  return spawn([cliPath, ...args].map(quoteWindowsShellArg).join(" "), {
    env: process.env,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

export async function runClaudeText(prompt, opts = {}) {
  const {
    cliPath = process.env.CLAUDE_BRAIN_CMD || "claude",
    model = process.env.CLAUDE_BRAIN_MODEL || "",
    timeoutMs = 120000
  } = opts;
  const args = [
    "-p",
    "--output-format",
    "text",
    "--append-system-prompt",
    "仅用你已有的知识简洁回答用户；不要使用任何工具、不要读写文件或运行命令。"
  ];

  if (model) {
    args.push("--model", model);
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawnClaude(cliPath, args);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Claude 超时：${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // Spawn failures can close stdin before the error event is emitted.
    });
    child.on("error", (error) => {
      finish(new Error(`Claude 启动失败：${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = trimError(stderr);
        const suffix = detail ? `：${detail}` : "";
        finish(new Error(`Claude 退出失败：${code ?? signal}${suffix}`));
        return;
      }

      const result = stdout.trim();
      if (!result) {
        finish(new Error("Claude 返回空"));
        return;
      }
      finish(null, result);
    });

    child.stdin.end(String(prompt ?? ""), "utf8");
  });
}
