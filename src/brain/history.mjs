import fs from "node:fs/promises";
import path from "node:path";

function emptyHistory() {
  return { turns: [], updatedAt: null };
}

export function appendTurn(history, turn, limits = {}) {
  const { maxTurns = 12, maxChars = 6000 } = limits;
  const turns = [...history.turns, turn];
  let charCount = turns.reduce((total, item) => total + item.text.length, 0);

  while (turns.length > maxTurns || charCount > maxChars) {
    charCount -= turns.shift().text.length;
  }

  return { turns, updatedAt: turn.atMs };
}

export function isStale(history, nowMs, idleMs) {
  if (!history.turns.length) return true;
  return nowMs - history.turns.at(-1).atMs > idleMs;
}

export function renderContext(history) {
  if (!history.turns.length) return "";
  const lines = history.turns.map((turn) => {
    const speaker = turn.role === "user" ? "用户" : "助手";
    return `${speaker}：${turn.text}`;
  });
  return ["[最近对话]", ...lines].join("\n");
}

export async function loadHistory(file) {
  try {
    const history = JSON.parse(await fs.readFile(file, "utf8"));
    if (!history || !Array.isArray(history.turns)) return emptyHistory();
    return history;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return emptyHistory();
    throw error;
  }
}

export async function saveHistory(file, history) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}
