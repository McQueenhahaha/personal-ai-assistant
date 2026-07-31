export const OWNER_COMMAND_MENU = [
  { command: "status", description: "📊 助手状态（开关 / 队列待处理）" },
  { command: "digest", description: "📋 发送综合摘要（学校/邮件/游戏/待办）" },
  { command: "school", description: "🎓 立即检查学校邮件" },
  { command: "mail", description: "✉️ 立即检查 Gmail 个人邮件" },
  { command: "game", description: "🎮 立即检查游戏资讯" },
  { command: "study", description: "📚 蒸馏课程主题，生成学习文档（后接主题）" },
  { command: "web", description: "🌐 用只读浏览器查看网页（后接任务）" },
  { command: "screen", description: "🖥 查看当前电脑屏幕（可后接说明）" },
  { command: "codex", description: "🛠 让电脑端 Codex 改/查本项目（后接任务）" },
  { command: "local", description: "🤖 交给本地模型队列处理（后接任务）" },
  { command: "pause", description: "⏸ 暂停自动摘要与检查" },
  { command: "stop", description: "🛑 急停所有自动处理并作废待确认任务" },
  { command: "resume", description: "▶️ 恢复自动摘要与检查" },
  { command: "defender_status", description: "🛡 Defender 状态" },
  { command: "defender_scan", description: "🛡 Defender 快速扫描" },
  { command: "sfc_scan", description: "🔧 系统文件检查 (SFC)" },
  { command: "dism_restore", description: "🔧 DISM 修复系统映像" },
  { command: "dism_scan", description: "🔧 DISM 扫描健康" },
  { command: "disk_status", description: "💽 磁盘卷状态" },
  { command: "disk_health", description: "💽 磁盘可靠性记录" }
];

export function validateCommandMenu(menu) {
  const errors = [];
  if (!Array.isArray(menu)) {
    errors.push("menu must be an array.");
    return errors;
  }

  if (menu.length < 1 || menu.length > 100) {
    errors.push(`menu length must be 1..100 (got ${menu.length}).`);
  }

  const seenCommands = new Set();
  for (const [index, item] of menu.entries()) {
    const command = item?.command;
    const description = item?.description;

    if (typeof command !== "string" || !/^[a-z0-9_]{1,32}$/.test(command)) {
      errors.push(`item ${index} command must match /^[a-z0-9_]{1,32}$/.`);
    } else if (seenCommands.has(command)) {
      errors.push(`item ${index} command duplicates "${command}".`);
    } else {
      seenCommands.add(command);
    }

    if (typeof description !== "string" || description.length === 0) {
      errors.push(`item ${index} description must be a non-empty string.`);
    } else if (description.length > 256) {
      errors.push(`item ${index} description must be at most 256 characters.`);
    }
  }

  return errors;
}
