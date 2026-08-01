import { macSatelliteHealth } from "./mac.mjs";
import { windowsPeerReachable } from "../brain/supervisor.mjs";

export const NODES = {
  windows: {
    id: "windows",
    label: "Windows",
    capabilities: ["files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"]
  },
  mac: {
    id: "mac",
    label: "Mac",
    capabilities: ["files", "browser", "screen", "canvas", "gui-control", "codex"]
  }
};

const MAC_BRAIN_UNAVAILABLE = new Set(["browser", "screen"]);

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

const MAC_BRAIN_PREFERENCES = {
  "gui-control": ["mac"],
  outlook: ["windows"],
  maintenance: ["windows"],
  canvas: ["mac"],
  files: ["mac"],
  browser: ["windows"],
  screen: ["windows"],
  codex: ["mac"]
};

const CAPABILITY_ALIASES = {
  assist: "codex",
  browse: "browser"
};

export function resolveBrainNodeId(env = process.env, platform = process.platform) {
  const configured = String(env.BRAIN_NODE_ID || "").trim().toLowerCase();
  if (configured === "windows" || configured === "mac") return configured;
  return platform === "win32" ? "windows" : "mac";
}

export function nodeRegistry({
  brainNodeId,
  env = process.env,
  platform = process.platform
} = {}) {
  const currentBrainId = brainNodeId || resolveBrainNodeId(env, platform);
  return Object.fromEntries(Object.entries(NODES).map(([nodeId, node]) => [
    nodeId,
    {
      ...node,
      capabilities: currentBrainId === "mac" && nodeId === "mac"
        ? node.capabilities.filter((capability) => !MAC_BRAIN_UNAVAILABLE.has(capability))
        : [...node.capabilities],
      local: nodeId === currentBrainId,
      brain: nodeId === currentBrainId,
      dispatchable: nodeId === currentBrainId || currentBrainId === "windows"
    }
  ]));
}

export function nodesFor(capability, { brainNodeId = resolveBrainNodeId() } = {}) {
  const normalized = CAPABILITY_ALIASES[capability] || capability;
  const preferences = brainNodeId === "mac" ? MAC_BRAIN_PREFERENCES : NODE_PREFERENCES;
  return [...(preferences[normalized] || [])];
}

async function defaultProbe(nodeId, { brainNodeId, env, platform }) {
  if (nodeId === brainNodeId) return true;
  if (brainNodeId === "windows" && nodeId === "mac") {
    const health = await macSatelliteHealth();
    return health.online && health.agentRunning;
  }
  if (brainNodeId === "mac" && nodeId === "windows") {
    return windowsPeerReachable({ env, platform });
  }
  return false;
}

function nodeLabel(nodeId, brainNodeId) {
  return nodeId === brainNodeId ? "这台电脑" : NODES[nodeId].label;
}

export async function pickNode(capability, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const brainNodeId = options.brainNodeId || resolveBrainNodeId(env, platform);
  const probe = options.probe || ((nodeId) => defaultProbe(nodeId, { brainNodeId, env, platform }));
  const candidates = nodesFor(capability, { brainNodeId });
  if (candidates.length === 0) {
    return { nodeId: null, brainNodeId, reason: `没有节点声明 ${capability} 能力` };
  }

  const unavailable = [];
  for (const nodeId of candidates) {
    try {
      if (await probe(nodeId)) {
        if (brainNodeId === "mac" && nodeId === "windows") {
          return {
            nodeId: null,
            brainNodeId,
            reason: "这个功能需要 Windows；它当前在线，但 Mac 无法向 Windows 下发任务（Windows 没有 SSH 服务端）"
          };
        }
        return {
          nodeId,
          brainNodeId,
          reason: `${nodeLabel(nodeId, brainNodeId)}在线且具备 ${capability} 能力`
        };
      }
      if (brainNodeId === "mac" && nodeId === "windows") {
        unavailable.push("这个功能需要 Windows，但它当前离线");
      } else {
        unavailable.push(`${nodeLabel(nodeId, brainNodeId)}不可用`);
      }
    } catch (error) {
      const detail = error?.message || String(error);
      unavailable.push(`${nodeLabel(nodeId, brainNodeId)}探测失败：${detail}`);
    }
  }

  return { nodeId: null, brainNodeId, reason: unavailable.join("；") };
}
