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
  { command: "mac", description: "💻 交给 Mac 执行（微信、Mac 上的应用）" },
  { command: "local", description: "🤖 交给本地模型队列处理（后接任务）" },
  // 描述必须与实际行为一致，不要承诺尚未实现的能力。
  // 三者的差别就在"打不打断正在跑的任务"和"之后停不停"：
  //   pause  不再领新任务，正在跑的照跑完
  //   cancel 掐掉当前这一个，助手继续领下一个
  //   stop   掐掉当前这一个，并且一直停着，直到 /resume
  { command: "pause", description: "⏸ 暂停自动摘要与检查（不打断正在跑的）" },
  { command: "cancel", description: "✋ 取消当前正在执行的任务（助手继续运行）" },
  { command: "stop", description: "🛑 急停：中断进行中的任务并暂停一切，直到 /resume" },
  { command: "resume", description: "▶️ 恢复，并报告暂停期间的积压" },
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
