export const TIER = {
  READONLY: "T0",
  SANDBOX: "T1",
  PRIVILEGED: "T2",
  FORBIDDEN: "T3"
};

const FORBIDDEN_RULES = [
  {
    reason: "付款、转账或汇款",
    patterns: [
      /付款|转账|汇款|打款/,
      /\b(?:make\s+(?:a\s+)?payment|pay|wire\s+(?:money|funds)|bank\s+transfer|send\s+money|remit)\b/i
    ]
  },
  {
    reason: "修改账号密码、2FA 或恢复邮箱",
    patterns: [
      /(?:修改|更改|重置|替换|关闭|禁用|移除|解绑)[^。；;\n]*(?:密码|口令|2FA|双重认证|两步验证|恢复邮箱|恢复邮件)/i,
      /(?:密码|口令|2FA|双重认证|两步验证|恢复邮箱|恢复邮件)[^。；;\n]*(?:修改|更改|重置|替换|关闭|禁用|移除|解绑)/i,
      /\b(?:change|reset|replace|disable|remove|turn\s+off|update)\b[^.\n]*(?:password|passcode|2fa|two-factor|recovery\s+email)/i,
      /\b(?:password|passcode|2fa|two-factor|recovery\s+email)\b[^.\n]*(?:change|reset|replace|disable|remove|turn\s+off|update)/i
    ]
  },
  {
    reason: "关闭 Defender、防火墙或篡改保护",
    patterns: [
      /(?:关闭|禁用|停用)[^。；;\n]*(?:Defender|防火墙|篡改保护)/i,
      /(?:Defender|防火墙|篡改保护)[^。；;\n]*(?:关闭|禁用|停用)/i,
      /\b(?:disable|stop|turn\s+off)\b[^.\n]*(?:defender|firewall|tamper\s+protection)/i,
      /\b(?:defender|firewall|tamper\s+protection)\b[^.\n]*(?:disable|stop|turn\s+off)/i
    ]
  },
  {
    reason: "格式化或递归删除用户数据",
    patterns: [
      /格式化[^。；;\n]*(?:磁盘|硬盘|分区|盘|卷)?/,
      /\bformat(?:\.com)?\s+(?:[a-z]:|\/dev\/)/i,
      /\brm\s+-[a-z]*r[a-z]*\s+(?:["']?(?:~(?:[\\/]|$)|\$(?:HOME|USERPROFILE)\b|%(?:HOME|USERPROFILE)%|[a-z]:[\\/]|\/(?:home|users)(?:\/|$)|\/["']?(?:\s|$)))/i,
      /\bremove-item\b[^\r\n]*-(?:recurse|r)\b[^\r\n]*(?:[a-z]:[\\/]|\$(?:HOME|USERPROFILE)\b|%(?:HOME|USERPROFILE)%|~[\\/]|\/(?:home|users)(?:\/|$))/i,
      /(?:删除|删掉|删光|清空|抹掉)[^。；;\n]*(?:所有|全部|整个)[^。；;\n]*(?:文件|目录|数据|资料)|(?:所有|全部|整个)[^。；;\n]*(?:文件|目录|数据|资料)[^。；;\n]*(?:删除|删掉|删光|清空|抹掉)/,
      /\b(?:delete|remove|erase|wipe)\b[^.\n]*(?:all|every|entire)[^.\n]*(?:files?|folders?|director(?:y|ies)|data)|\b(?:all|every|entire)\b[^.\n]*(?:files?|folders?|director(?:y|ies)|data)[^.\n]*(?:delete|remove|erase|wipe)/i
    ]
  },
  {
    reason: "外发或打印 .env、token、密钥或 cookie",
    patterns: [
      /(?:发送|外发|转发|上传|打印|输出|贴出|公开|展示)[^。；;\n]*(?:\.env\b|token\b|令牌|密钥|秘钥|cookie\b|凭据)/i,
      /(?:\.env\b|token\b|令牌|密钥|秘钥|cookie\b|凭据)[^。；;\n]*(?:发送|外发|转发|上传|打印|输出|贴出|公开|展示)/i,
      /\b(?:send|forward|upload|print|output|dump|post|publish|share|exfiltrate)\b[^.\n]*(?:\.env\b|tokens?\b|api\s*keys?\b|secrets?\b|cookies?\b|credentials?\b)/i,
      /(?:\.env\b|\btokens?\b|api\s*keys?\b|secrets?\b|cookies?\b|credentials?\b)[^.\n]*\b(?:send|forward|upload|print|output|dump|post|publish|share|exfiltrate)\b/i
    ]
  }
];

const PRIVILEGED_RULES = [
  {
    reason: "安装或卸载软件",
    patterns: [
      /安装|卸载|装(?:个|一下|上)?(?:这个|一个)?软件|移除软件/,
      /\b(?:install|uninstall)\b/i
    ]
  },
  {
    reason: "修改计划任务、注册表或系统设置",
    patterns: [
      /(?:修改|更改|创建|新建|删除|写入|导入|设置)[^。；;\n]*(?:计划任务|注册表|系统设置)/,
      /(?:计划任务|注册表|系统设置)[^。；;\n]*(?:修改|更改|创建|新建|删除|写入|导入|设置)/,
      /\b(?:modify|change|create|delete|write|import|set)\b[^.\n]*(?:scheduled\s+tasks?|registry|system\s+settings?)/i,
      /\b(?:scheduled\s+tasks?|registry|system\s+settings?)\b[^.\n]*(?:modify|change|create|delete|write|import|set)/i
    ]
  },
  {
    reason: "操作项目目录以外的路径",
    patterns: [
      /项目(?:目录|文件夹)(?:以外|之外)|(?:项目|工程)(?:外部|外面)的?(?:目录|路径|文件)/,
      /\boutside\s+(?:the\s+)?(?:project|workspace)(?:\s+(?:directory|folder))?\b/i,
      /(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/][^\\/\s]+|%(?:USERPROFILE|APPDATA|TEMP)%|\$(?:HOME|USERPROFILE)\b|~[\\/]|\/(?:etc|home|users|var|opt)(?:\/|$)|\.\.[\\/])/i
    ]
  },
  {
    reason: "发送邮件、提交表单或下单",
    patterns: [
      /(?:发|发送|寄|回复|转发)[^。；;\n]*(?:邮件|电邮)|(?:邮件|电邮)[^。；;\n]*(?:发|发送|寄|回复|转发)|提交[^。；;\n]*表单|表单[^。；;\n]*提交|下单|购买/,
      /\b(?:send|reply\s+to|forward)\b[^.\n]*(?:email|mail)|\bemail\b[^.\n]*(?:send|reply|forward)|\bsubmit\b[^.\n]*\bform\b|\bform\b[^.\n]*\bsubmit\b|\b(?:place\s+(?:an?\s+)?order|purchase|buy)\b/i
    ]
  },
  {
    reason: "点击鼠标或注入键盘输入",
    patterns: [
      /点击|点一下|鼠标操作|移动(?:鼠标|光标)|键盘注入|模拟按键|输入|键入|打字|按(?:下)?[^。；;\n]*(?:按键|键|回车|Enter|Tab|Escape)/i,
      /\b(?:click|move\s+the\s+(?:mouse|cursor)|mouse\s+click|keyboard\s+injection|inject\s+keystrokes?|press\s+(?:the\s+)?(?:key|enter|tab|escape|esc))\b|^\s*(?:please\s+)?(?:type|enter)\s+\S+|\b(?:type|enter)\b[^.\n]*(?:into|text\s*field|input\s*box)/i
    ]
  }
];

const READONLY_INTENT = /查找|查询|查看|看下|看一下|看看|读取|阅读|找下|找一下|寻找|搜索|检索|列出|是什么|什么是|怎么|如何|为什么|状态|查|看|读|找|\b(?:where|what|how|why|find|search|look\s*up|read|view|show|check|list|inspect|explain)\b/i;
const WRITE_ACTION = /写入|写个|修改|更改|编辑|删除|删掉|创建|新建|保存|移动|复制|重命名|运行|执行|安装|卸载|发送|提交|下单|付款|转账|点击|输入|更新|设置|开启|关闭|启用|禁用|修复|清理|写|改|删|\b(?:write|modify|change|edit|delete|remove|create|save|move|copy|rename|run|execute|install|uninstall|send|submit|order|pay|transfer|click|type|update|set|enable|disable|fix|clean)\b/i;
const DIRECT_BROWSER_INTENT = /(?:^\s*\[web\]\s*|canvas|b站|哔哩哔哩|bilibili|网页|网站|浏览器|链接|https?:\/\/|登录|\b(?:browse|website|web\s*page|urls?|online)\b)/i;
const BROWSER_LOOKUP_INTENT = /(?:查一下|查下|查看|看一下|看下|看看|阅读|读一下)[^。！？!?\n]{1,40}上(?:的)?/i;
const LOCAL_RESOURCE_INTENT = /本地|电脑(?:里|上)?|桌面|文件|文件夹|目录|磁盘|硬盘|项目|工程/i;
const SCREEN_INTENT = /(?:^\s*\[screen\]\s*|截图|截屏|截(?:个|一个|一下)图|看(?:下|一下|看)?(?:我(?:的)?|当前)?屏幕|我的屏幕|屏幕上|当前画面|电脑上现在|桌面上|看(?:下|一下|看)?(?:我(?:的)?|当前)?桌面|这个窗口|\bscreenshot\b|\bmy\s+screen\b|\bwhat(?:'s|\s+is)\s+on\s+my\s+screen\b)/i;

export function needsBrowser(text) {
  const input = String(text ?? "");
  if (DIRECT_BROWSER_INTENT.test(input)) return true;
  return BROWSER_LOOKUP_INTENT.test(input) && !LOCAL_RESOURCE_INTENT.test(input);
}

export function needsScreen(text) {
  return SCREEN_INTENT.test(String(text ?? ""));
}

export function pickCapability({ tier, needsBrowser: browser = false, needsScreen: screen = false } = {}) {
  if (tier === TIER.FORBIDDEN) return "deny";
  if (tier === TIER.PRIVILEGED) return "confirm";
  if (browser) return "browse";
  if (screen) return "screen";
  return "assist";
}

function matchRule(text, rules) {
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) return { reason: rule.reason, matched: match[0] };
    }
  }
  return null;
}

export function classifyTask(text) {
  const input = String(text ?? "");
  const forbidden = matchRule(input, FORBIDDEN_RULES);
  if (forbidden) return { tier: TIER.FORBIDDEN, ...forbidden };

  const privileged = matchRule(input, PRIVILEGED_RULES);
  if (privileged) return { tier: TIER.PRIVILEGED, ...privileged };

  const screenMatch = input.match(SCREEN_INTENT);
  if (screenMatch) {
    return {
      tier: TIER.SANDBOX,
      reason: "查看屏幕或截图",
      matched: screenMatch[0]
    };
  }

  const readonlyMatch = input.match(READONLY_INTENT);
  const writeMatch = input.match(WRITE_ACTION);
  if (readonlyMatch && !writeMatch) {
    return {
      tier: TIER.READONLY,
      reason: "只读查询、读取或搜索",
      matched: readonlyMatch[0]
    };
  }

  return {
    tier: TIER.SANDBOX,
    reason: "未命中只读意图，按默认沙箱档处理",
    matched: writeMatch?.[0] || ""
  };
}
