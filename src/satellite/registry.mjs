import { resolveNodeId, windowsPeerReachable } from "../brain/supervisor.mjs";

const SSH_HOST_ENV = {
  windows: "WINDOWS_SSH_HOST",
  mac: "MAC_SATELLITE_HOST"
};

export const NODES = {
  windows: {
    id: "windows",
    label: "Windows",
    capabilities: ["files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"],
    ssh: { host: "", keyEnv: "WINDOWS_SSH_KEY", agentKind: "windows" }
  },
  mac: {
    id: "mac",
    label: "Mac",
    capabilities: ["files", "canvas", "codex", "gui-control"],
    ssh: { host: "", keyEnv: "MAC_SATELLITE_KEY", agentKind: "mac" }
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
      ssh: {
        ...node.ssh,
        host: String(env[SSH_HOST_ENV[nodeId]] || "").trim()
      },
      local: nodeId === currentBrainId,
      brain: nodeId === currentBrainId,
      dispatchable: nodeId === currentBrainId || Boolean(
        String(env[SSH_HOST_ENV[nodeId]] || "").trim() &&
        String(env[node.ssh.keyEnv] || "").trim()
      )
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
    const { macSatelliteHealth } = await import("./mac.mjs");
    return macSatelliteHealth({ env });
  }
  if (selfId === "mac" && nodeId === "windows") {
    const peer = windowsPeerReachable({ env, platform });
    if (!peer.online) return peer;
    const { windowsSatelliteHealth } = await import("./dispatch.mjs");
    return windowsSatelliteHealth({ env, platform });
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
  const registry = nodeRegistry({ selfId, env, platform });
  const candidates = nodesFor(capability, { selfId });
  if (candidates.length === 0) {
    return { nodeId: null, brainNodeId: selfId, reason: `没有节点声明 ${capability} 能力` };
  }

  const unavailable = [];
  for (const nodeId of candidates) {
    if (nodeId !== selfId && !probes && !registry[nodeId].dispatchable) {
      const { host, keyEnv } = registry[nodeId].ssh;
      const missing = [
        !host ? SSH_HOST_ENV[nodeId] : "",
        !String(env[keyEnv] || "").trim() ? keyEnv : ""
      ].filter(Boolean);
      unavailable.push(`${registry[nodeId].label} 缺少 SSH 配置：${missing.join("、")}`);
      continue;
    }
    const status = await nodeStatus(nodeId, { selfId, probes, env, platform });
    if (nodeAvailable(status)) {
      return {
        nodeId,
        brainNodeId: selfId,
        reason: `${nodeLabel(nodeId, selfId)}在线且具备 ${capability} 能力`
      };
    }
    if (selfId === "mac" && nodeId === "windows") {
      unavailable.push(`Windows 不可达或受限代理未响应，无法使用 ${capability} 能力`);
    } else {
      unavailable.push(`${nodeLabel(nodeId, selfId)}不可用`);
    }
  }

  return { nodeId: null, brainNodeId: selfId, reason: unavailable.join("；") };
}
