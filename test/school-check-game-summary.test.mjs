import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGameSummary } from "../src/school/workflow.mjs";

const timeZone = "Etc/GMT-10";
const gameItems = [
  {
    game: "War Thunder",
    sourceType: "official-site",
    source: "War Thunder News",
    title: "Development Sound Mods - War Thunder",
    pubDate: "2026-06-24T03:04:05.000Z",
    link: "https://example.com/sound-mods"
  },
  {
    game: "Escape from Tarkov",
    sourceType: "tarkov-official",
    source: "Tarkov",
    title: "Event Special Rewards - Escape from Tarkov",
    pubDate: "2026-06-23T02:00:00.000Z",
    link: "https://example.com/tarkov-event"
  },
  {
    game: "WARNO",
    sourceType: "official-site",
    source: "Steam",
    title: "Community Update No.12 - Steam",
    pubDate: "",
    link: ""
  }
];

test("formatGameSummary keeps empty output without timezone footer", () => {
  const text = formatGameSummary([], { slotLabel: "manual", timeZone });

  assert.equal(
    text,
    [
      "游戏资讯检查（Etc/GMT-10 manual）",
      "",
      "- 暂无新的游戏资讯。"
    ].join("\n")
  );
  assert.equal(text.includes("时区："), false);
});

test("formatGameSummary formats a single game item", () => {
  assert.equal(
    formatGameSummary([gameItems[0]], { slotLabel: "10:30", timeZone }),
    [
      "游戏资讯检查（Etc/GMT-10 10:30）",
      "",
      "- [战雷官方] 开发日志：声音 Mod｜War Thunder News｜2026-06-24",
      "  https://example.com/sound-mods",
      "",
      "时区：Etc/GMT-10"
    ].join("\n")
  );
});

test("formatGameSummary truncates output with maxItems", () => {
  assert.equal(
    formatGameSummary(gameItems, { slotLabel: "10:30", timeZone, maxItems: 2 }),
    [
      "游戏资讯检查（Etc/GMT-10 10:30）",
      "",
      "- [战雷官方] 开发日志：声音 Mod｜War Thunder News｜2026-06-24",
      "  https://example.com/sound-mods",
      "- [塔科夫官方] 活动：Special Rewards｜Tarkov｜2026-06-23",
      "  https://example.com/tarkov-event",
      "",
      "时区：Etc/GMT-10"
    ].join("\n")
  );
});
