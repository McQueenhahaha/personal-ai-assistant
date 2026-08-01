import { macSatelliteHealth } from "./mac.mjs";
import { resolveNodeId, windowsPeerReachable } from "../brain/supervisor.mjs";

export const NODES = {
  windows: {
    id: "windows",
    label: "Windows",
    capabilities: ["files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"]
  },
  mac: {
    id: "mac",
    label: "Mac",
    capabilities: ["files", "canvas", "codex", "gui-control"]
  }
};

// GUI 操控优先 Mac：用户实测 Mac 上 Codex 的 computer use 更强。
// 其余通用能力优先 Windows：它是常开的主力机，浏览器也有已登录的 Canvas profile。
export const NODE_PREFERENCES = {
  "gui-control": ["mac", "windows"],
  outlook: ["windows"],
  maintenance: ["windows"],
  canvas: ["windows", "mac"],
  files: ["windows", "mac"],
  browser: ["windows"],
  screen: ["windows"],
  codex: ["windows", "mac"]
};

const MAC_BRAIN_PREFERENCES = {
  "gui-control": ["mac", "windows"],
  outlook: ["windows"],
  maintenance: ["windows"],
  canvas: ["mac", "windows"],
  files: ["mac", "windows"],
  browser: ["windows"],
  screen: ["windows"],
  codex: ["mac", "windows"]
};

const CAPABILITY_ALIASES = {
  assist: "codex",
  browse: "browser"
};

export function resolveBrainNodeId(env = process.env, platform = process.platform) {
  return resolveNodeId(env, platform);
}

export function nodeRegistry({
  selfId,
  brainNodeId,
  env = process.env,
  platform = process.platform
} = {}) {
  const currentBrainId = selfId || brainNodeId || resolveNodeId(env, platform);
  return Object.fromEntries(Object.entries(NODES).map(([nodeId, node]) => [
    nodeId,
    {
      ...node,
      capabilities: [...node.capabilities],
      local: nodeId === currentBrainId,
      brain: nodeId === currentBrainId,
      dispatchable: nodeId === currentBrainId || currentBrainId === "windows"
    }
  ]));
}

export function nodesFor(capability, options = {}) {
  const selfId = options.selfId || options.brainNodeId || resolveNodeId();
  const normalized = CAPABILITY_ALIASES[capability] || capability;
  const preferences = selfId === "mac" ? MAC_BRAIN_PREFERENCES : NODE_PREFERENCES;
  return [...(preferences[normalized] || [])];
}

async function defaultProbe(nodeId, { selfId, env, platform }) {
  if (selfId === "windows" && nodeId === "mac") {
    return macSatelliteHealth({ env });
  }
  if (selfId === "mac" && nodeId === "windows") {
    return windowsPeerReachable({ env, platform });
  }
  return { online: false };
}

export async function nodeStatus(nodeId, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const selfId = options.selfId || resolveNodeId(env, platform);
  if (nodeId === selfId) return { online: true, self: true };

  const probe = options.probes?.[nodeId] ||
    (() => defaultProbe(nodeId, { selfId, env, platform }));
  try {
    const result = await probe();
    if (typeof result === "boolean") return { online: result, self: false };
    return { ...result, online: result?.online === true, self: false };
  } catch {
    return { online: false, self: false };
  }
}

function nodeLabel(nodeId, selfId) {
  return nodeId === selfId ? "这台电脑" : NODES[nodeId].label;
}

function nodeAvailable(status) {
  return status.online && status.agentRunning !== false;
}

export async function pickNode(capability, options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const selfId = options.selfId || options.brainNodeId || resolveNodeId(env, platform);
  const probes = options.probes || (options.probe
    ? Object.fromEntries(Object.keys(NODES).map((nodeId) => [nodeId, () => options.probe(nodeId)]))
    : undefined);
  const candidates = nodesFor(capability, { selfId });
  if (candidates.length === 0) {
    return { nodeId: null, brainNodeId: selfId, reason: `没有节点声明 ${capability} 能力` };
  }

  const unavailable = [];
  for (const nodeId of candidates) {
    const status = await nodeStatus(nodeId, { selfId, probes, env, platform });
    if (nodeAvailable(status)) {
      if (selfId === "mac" && nodeId === "windows") {
        return {
          nodeId: null,
          brainNodeId: selfId,
          reason: "这个功能需要另一台电脑；它当前在线，但 Mac 无法向 Windows 下发任务（Windows 没有 SSH 服务端）"
        };
      }
      return {
        nodeId,
        brainNodeId: selfId,
        reason: `${nodeLabel(nodeId, selfId)}在线且具备 ${capability} 能力`
      };
    }
    if (selfId === "mac" && nodeId === "windows") {
      unavailable.push("这个功能需要另一台电脑，它当前离线");
    } else {
      unavailable.push(`${nodeLabel(nodeId, selfId)}不可用`);
    }
  }

  return { nodeId: null, brainNodeId: selfId, reason: unavailable.join("；") };
}
