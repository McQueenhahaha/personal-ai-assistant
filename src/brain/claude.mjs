import { spawn } from "node:child_process";

const SYSTEM_INSTRUCTION = "你是用户的 Telegram 个人助手，用简体中文、简洁、口语化回答；若是任务请直接给结论或步骤；不确定就说不确定。";

export function buildBrainPrompt(question, context = "") {
  const questionText = typeof question === "string" ? question : "";
  const contextText = typeof context === "string" ? context : "";
  const parts = [SYSTEM_INSTRUCTION];

  if (contextText) {
    parts.push("", `背景：\n${contextText}`);
  }

  parts.push("", `用户：${questionText}`);
  return parts.join("\n");
}

export async function askClaude(question, opts = {}) {
  try {
    const {
      context = "",
      timeoutMs = 90000,
      cliPath = process.env.CLAUDE_BRAIN_CMD || "claude",
      model = process.env.CLAUDE_BRAIN_MODEL || ""
    } = opts || {};
    const prompt = buildBrainPrompt(question, context);
    const args = ["-p", "--output-format", "text"];

    if (model) {
      args.push("--model", model);
    }

    return await new Promise((resolve) => {
      let stdout = "";
      let settled = false;
      const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "ignore"] });
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Best effort only; callers still receive null.
        }
        finish(null);
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", () => {
        finish(null);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(null);
          return;
        }
        const text = stdout.trim();
        finish(text || null);
      });

      try {
        child.stdin.end(prompt);
      } catch {
        try {
          child.kill();
        } catch {
          // Best effort only; callers still receive null.
        }
        finish(null);
      }
    });
  } catch {
    return null;
  }
}
