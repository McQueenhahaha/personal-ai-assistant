import { macSatelliteHealth } from "./mac.mjs";

export const NODES = {
  windows: {
    id: "windows",
    label: "这台电脑",
    local: true,
    capabilities: ["files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"]
  },
  mac: {
    id: "mac",
    label: "Mac",
    local: false,
    capabilities: ["files", "browser", "screen", "gui-control", "codex"]
  }
};

// GUI 操控优先 Mac：用户实测 Mac 上 Codex 的 computer use 更强。
// 其余通用能力优先 Windows：它是常开的主力机，浏览器也有已登录的 Canvas profile。
export const NODE_PREFERENCES = {
  "gui-control": ["mac", "windows"],
  outlook: ["windows"],
  maintenance: ["windows"],
  canvas: ["windows"],
  files: ["windows", "mac"],
  browser: ["windows", "mac"],
  screen: ["windows", "mac"],
  codex: ["windows", "mac"]
};

const CAPABILITY_ALIASES = {
  assist: "codex",
  browse: "browser"
};

export function nodesFor(capability) {
  const normalized = CAPABILITY_ALIASES[capability] || capability;
  return [...(NODE_PREFERENCES[normalized] || [])];
}

async function defaultProbe(nodeId) {
  if (nodeId === "windows") return true;
  if (nodeId === "mac") {
    const health = await macSatelliteHealth();
    return health.online && health.agentRunning;
  }
  return false;
}

export async function pickNode(capability, { probe = defaultProbe } = {}) {
  const candidates = nodesFor(capability);
  if (candidates.length === 0) {
    return { nodeId: null, reason: `没有节点声明 ${capability} 能力` };
  }

  const unavailable = [];
  for (const nodeId of candidates) {
    try {
      if (await probe(nodeId)) {
        return {
          nodeId,
          reason: `${NODES[nodeId].label}在线且具备 ${capability} 能力`
        };
      }
      unavailable.push(`${NODES[nodeId].label}不可用`);
    } catch (error) {
      const detail = error?.message || String(error);
      unavailable.push(`${NODES[nodeId].label}探测失败：${detail}`);
    }
  }

  return { nodeId: null, reason: unavailable.join("；") };
}
