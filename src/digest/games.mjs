export function translateGameTitle(title) {
  return title
    .replace(/\s+-\s+[^-]+$/g, "")
    .replace(/^Community Update No\.(\d+):\s*/i, "社区更新第 $1 期：")
    .replace(/Community Update No\.?(\d+)/i, "社区更新第 $1 期")
    .replace(/^Development\s+/i, "开发日志：")
    .replace(/^Event\s+/i, "活动：")
    .replace(/^Special\s+/i, "特别活动：")
    .replace(/^Pre-order:\s*/i, "预购：")
    .replace(/Pre Order/gi, "预购")
    .replace(/Jean Bart The Last French Battleship/gi, "Jean Bart，最后的法国战列舰")
    .replace(/Legend Of Victory Kv 8/gi, "胜利传奇 KV-8")
    .replace(/A Decal Trophy For Us Armed Forces Day/gi, "美国武装部队日贴花奖杯")
    .replace(/Nuclear Escalation/gi, "核升级")
    .replace(/Tropic Storm Division #(\d+)/gi, "Tropic Storm 师级预览 #$1")
    .replace(/TROPIC Division #(\d+)/gi, "Tropic 师级预览 #$1")
    .replace(/^Monthly Decals/i, "每月贴花")
    .replace(/^Special:\s*/i, "特别活动：")
    .replace(/^Event:\s*/i, "活动：")
    .replace(/^Development:\s*/i, "开发日志：")
    .replace(/^Fixed! /i, "修复日志：")
    .replace(/Patch notes/i, "更新说明")
    .replace(/Major Update/i, "大型更新")
    .replace(/Sound Mods/i, "声音 Mod")
    .replace(/More/i, "更多内容")
    .replace(/discounts?/gi, "折扣")
    .replace(/trophy/gi, "奖杯/箱子")
    .replace(/decal/gi, "贴花")
    .replace(/vehicle event/gi, "载具活动")
    .replace(/event vehicle/gi, "活动载具")
    .replace(/rumor round-up/gi, "传闻汇总")
    .replace(/leaked/gi, "泄露")
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

export function formatGameItem(item) {
  const title = translateGameTitle(item.title);
  const source = item.source ? `｜${item.source}` : "";
  const link = item.link ? `\n  ${item.link}` : "";
  return `- [${gamePrefix(item)}] ${title}${source}${link}`;
}
