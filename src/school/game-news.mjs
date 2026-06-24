export function gameKey(item) {
  return `${item.game || "game"}|${item.title}|${item.link || ""}`.toLowerCase();
}

export function countGameSources(items) {
  const counts = {};
  for (const item of items) {
    const key = `${item.game || "unknown"}:${item.sourceType || "unknown"}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function translateGameTitle(title) {
  return String(title || "")
    .replace(/\s+-\s+Bilibili$/i, "")
    .replace(/\s+-\s+[^-]+$/g, "")
    .replace(/^Development\s+/i, "开发日志：")
    .replace(/^Event\s+/i, "活动：")
    .replace(/^Special\s+/i, "特别活动：")
    .replace(/Community Update No\.?(\d+)/i, "社区更新第 $1 期")
    .replace(/Pre Order/gi, "预购")
    .replace(/Jean Bart The Last French Battleship/gi, "Jean Bart，最后的法国战列舰")
    .replace(/Legend Of Victory Kv 8/gi, "胜利传奇 KV-8")
    .replace(/A Decal Trophy For Us Armed Forces Day/gi, "美国武装部队日贴花奖杯")
    .replace(/Nuclear Escalation/gi, "核升级")
    .replace(/Sound Mods/gi, "声音 Mod")
    .replace(/More/gi, "更多内容")
    .replace(/Tropic Storm Division #(\d+)/gi, "Tropic Storm 师级预览 #$1")
    .replace(/TROPIC Division #(\d+)/gi, "Tropic 师级预览 #$1")
    .trim();
}

export function gamePrefix(item) {
  if (item.sourceType === "tarkov-official") return "塔科夫官方";
  if (item.sourceType === "tarkov-bilibili") return "塔科夫/B站纱雾";
  if (item.game === "WARNO") return "WARNO 官方";
  if (item.sourceType === "war-thunder-bilibili") return "战雷/B站 SwordXue";
  if (item.sourceType === "official-site") return "战雷官方";
  if (item.sourceType === "google-news" && item.game === "War Thunder") return "战雷论坛/传闻";
  if (item.game === "Escape from Tarkov") return "塔科夫";
  return item.game || "游戏";
}
