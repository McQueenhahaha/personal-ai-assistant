import fs from "node:fs";
import path from "node:path";
import { resolveFromCwd } from "../env.mjs";

export function statePath() {
  return resolveFromCwd("./data/state/school-check-state.json");
}

export function loadState() {
  const file = statePath();
  if (!fs.existsSync(file)) {
    return {
      slots: {},
      seenMessageKeys: [],
      seenPersonalKeys: [],
      seenGameKeys: [],
      remindedDeadlineKeys: [],
      schoolCatchup: null,
      gameCatchup: null,
      lastDigestKey: null,
      lastDigestSentAt: null
    };
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      slots: {},
      seenMessageKeys: [],
      seenPersonalKeys: [],
      seenGameKeys: [],
      remindedDeadlineKeys: [],
      schoolCatchup: null,
      gameCatchup: null,
      lastDigestKey: null,
      lastDigestSentAt: null
    };
  }
}

export function saveState(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.seenMessageKeys = [...new Set(state.seenMessageKeys || [])].slice(-2000);
  state.seenPersonalKeys = [...new Set(state.seenPersonalKeys || [])].slice(-2000);
  state.seenGameKeys = [...new Set(state.seenGameKeys || [])].slice(-2000);
  state.remindedDeadlineKeys = [...new Set(state.remindedDeadlineKeys || [])].slice(-1000);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}
