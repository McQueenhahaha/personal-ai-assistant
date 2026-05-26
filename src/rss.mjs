function decodeEntities(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(value) {
  return decodeEntities(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripTags(match[1]) : "";
}

function buildGoogleNewsUrl(query, locale, ceid) {
  const params = new URLSearchParams({
    q: query,
    hl: locale,
    gl: ceid.split(":")[0] || "AU",
    ceid
  });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

function absoluteUrl(base, href) {
  return new URL(href, base).toString();
}

function parseItemDate(item) {
  if (!item?.pubDate) return null;
  const date = new Date(item.pubDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFreshItem(item, maxAgeDays) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return true;
  const date = parseItemDate(item);
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
}

async function fetchRss(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "personal-ai-assistant/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`RSS fetch failed ${response.status} for ${url}`);
  }

  return response.text();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRssItems(xml, sourceUrl) {
  const items = [];
  const matches = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);

  for (const match of matches) {
    const block = match[1];
    const title = tagValue(block, "title");
    const link = tagValue(block, "link");
    const pubDate = tagValue(block, "pubDate");
    const source = tagValue(block, "source");
    const description = tagValue(block, "description");

    if (!title || !link) continue;
    items.push({
      title,
      link,
      pubDate,
      source: source || new URL(sourceUrl).hostname,
      description
    });
  }

  return items;
}

function slugTitle(urlPath) {
  const slug = urlPath
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/-\w{2}$/, "")
    ?.replace(/^\d+-/, "")
    ?.replace(/-/g, " ");
  if (!slug) return "";
  return slug.replace(/\b\w/g, (char) => char.toUpperCase());
}

async function fetchGoogleNewsItems({ query, maxItems, locale, ceid, sourceLabel, game, excludeTerms }) {
  const url = buildGoogleNewsUrl(query, locale, ceid);
  const xml = await fetchRss(url);
  return parseRssItems(xml, url)
    .filter((item) => !shouldExcludeItem(item, excludeTerms))
    .filter((item) => !/^latest topics\b/i.test(item.title))
    .slice(0, maxItems)
    .map((item) => ({
      ...item,
      query,
      game,
      source: sourceLabel || item.source,
      sourceType: "google-news"
    }));
}

async function fetchBilibiliUserVideos(options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchBilibiliUserVideosOnce(options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

async function fetchBilibiliUserVideosOnce({ mid, maxItems, sourceLabel, game, sourceType = "bilibili-dynamic" }) {
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": `https://space.bilibili.com/${mid}/dynamic`
  };
  const spiResponse = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
    headers: baseHeaders
  });
  if (!spiResponse.ok) {
    throw new Error(`Bilibili buvid fetch failed ${spiResponse.status}`);
  }

  const spi = await spiResponse.json();
  const cookie = [
    `buvid3=${spi.data?.b_3 || ""}`,
    `buvid4=${spi.data?.b_4 || ""}`,
    "CURRENT_FNVAL=4048"
  ].join("; ");

  const url = `https://api.bilibili.com/x/polymer/web-dynamic/desktop/v1/feed/space?host_mid=${encodeURIComponent(mid)}&timezone_offset=-480`;
  const response = await fetch(url, {
    headers: {
      ...baseHeaders,
      Cookie: cookie
    }
  });
  if (!response.ok) {
    throw new Error(`Bilibili dynamic fetch failed ${response.status}`);
  }

  const json = await response.json();
  if (json.code !== 0) {
    throw new Error(`Bilibili dynamic fetch returned ${json.code}: ${json.message}`);
  }

  const items = [];
  for (const item of json.data?.items || []) {
    const author = item.modules?.find((module) => module.module_author)?.module_author;
    const dynamic = item.modules?.find((module) => module.module_dynamic)?.module_dynamic;
    const archive = dynamic?.dyn_archive;
    if (!archive?.bvid || !archive?.title || dynamic?.type !== "MDL_DYN_TYPE_ARCHIVE") continue;

    items.push({
      title: archive.title,
      link: `https://www.bilibili.com/video/${archive.bvid}`,
      pubDate: author?.pub_ts ? new Date(Number(author.pub_ts) * 1000).toUTCString() : "",
      source: sourceLabel,
      description: archive.desc || author?.pub_text || "",
      query: `bilibili:${mid}`,
      game,
      sourceType
    });

    if (items.length >= maxItems) break;
  }

  if (items.length === 0) {
    throw new Error(`Bilibili dynamic returned no video items for ${mid}`);
  }

  return items;
}

async function fetchTarkovOfficialNews({ maxItems }) {
  const url = "https://www.escapefromtarkov.com/site/api/v1/news-list/0/en?page=1";
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.escapefromtarkov.com/news"
    }
  });

  if (!response.ok) {
    throw new Error(`Tarkov official news fetch failed ${response.status}`);
  }

  const json = await response.json();
  return (json.list || [])
    .filter((item) => item?.name && item?.link)
    .slice(0, maxItems)
    .map((item) => ({
      title: item.name,
      link: absoluteUrl("https://www.escapefromtarkov.com", item.link),
      pubDate: item.date ? new Date(item.date).toUTCString() : "",
      source: "Escape from Tarkov 官方",
      description: stripTags(item.smallDescr || item.descr || ""),
      query: "tarkov-official",
      game: "Escape from Tarkov",
      sourceType: "tarkov-official"
    }));
}

async function fetchSteamNewsItems({ url, maxItems, sourceLabel, game }) {
  const xml = await fetchRss(url);
  return parseRssItems(xml, url)
    .slice(0, maxItems)
    .map((item) => ({
      ...item,
      query: url,
      game,
      source: sourceLabel,
      sourceType: "steam-rss"
    }));
}

async function fetchWarThunderOfficial({ maxItems }) {
  const base = "https://warthunder.com";
  const response = await fetch(`${base}/en/news/`, {
    headers: {
      "User-Agent": "personal-ai-assistant/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`War Thunder official fetch failed ${response.status}`);
  }

  const html = await response.text();
  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/href="(\/en\/news\/[^"#?]+)"/g)) {
    const href = match[1];
    if (href.includes("/page/")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const lower = href.toLowerCase();
    if (!/(event|development|dev-blog|devblog|update|fixed|special|decals|shop)/.test(lower)) continue;
    links.push(href);
    if (links.length >= maxItems) break;
  }

  const items = [];
  for (const href of links) {
    const link = absoluteUrl(base, href);
    let title = slugTitle(href);
    let pubDate = "";
    try {
      const articleResponse = await fetch(link, {
        headers: {
          "User-Agent": "personal-ai-assistant/0.1"
        }
      });
      if (articleResponse.ok) {
        const articleHtml = await articleResponse.text();
        const titleMatch = articleHtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
        if (titleMatch) {
          title = decodeEntities(titleMatch[1])
            .replace(/\s+-\s+News\s+-\s+War Thunder$/i, "")
            .replace(/^\[([^\]]+)\]\s*/i, "$1 ");
        }
        const dateMatch = articleHtml.match(/<div class="article-meta">\s*([^<]+?)\s*</i);
        if (dateMatch) {
          pubDate = new Date(`${dateMatch[1].trim()} UTC`).toUTCString();
        }
      }
    } catch {
      // Keep the list item from the news page if the article detail fetch fails.
    }

    items.push({
      title,
      link,
      pubDate,
      source: "War Thunder 官方",
      description: "",
      query: "warthunder.com/en/news",
      game: "War Thunder",
      sourceType: "official-site"
    });
  }

  return items;
}

function shouldExcludeItem(item, excludeTerms) {
  if (excludeTerms.length === 0) return false;
  const haystack = [
    item.title,
    item.description,
    item.source
  ].join(" ").toLowerCase();
  return excludeTerms.some((term) => haystack.includes(term.toLowerCase()));
}

export async function fetchGameNews({ queries, maxPerQuery, locale, ceid, excludeTerms = [] }) {
  const seen = new Set();
  const allItems = [];
  const maxAgeDays = Number(process.env.GAME_NEWS_MAX_AGE_DAYS || "7");

  const profile = (process.env.GAME_SOURCE_PROFILE || "").toLowerCase();

  if (profile === "curated") {
    const curatedJobs = [
      () => fetchTarkovOfficialNews({
        maxItems: Number(process.env.TARKOV_OFFICIAL_MAX_ITEMS || "4")
      }),
      async () => {
        try {
          return await fetchBilibiliUserVideos({
            mid: process.env.TARKOV_BILIBILI_MID || "152065343",
            maxItems: 3,
            sourceLabel: "B站 纱雾最可爱辣",
            game: "Escape from Tarkov",
            sourceType: "tarkov-bilibili"
          });
        } catch {
          return fetchGoogleNewsItems({
            query: process.env.TARKOV_BILIBILI_QUERY || 'site:bilibili.com/video 纱雾最可爱辣 逃离塔科夫',
            maxItems: 3,
            locale: "zh-CN",
            ceid: "CN:zh-Hans",
            sourceLabel: "B站 纱雾最可爱辣",
            game: "Escape from Tarkov",
            excludeTerms
          });
        }
      },
      () => fetchWarThunderOfficial({ maxItems: 4 }),
      async () => {
        try {
          return await fetchBilibiliUserVideos({
            mid: process.env.WAR_THUNDER_BILIBILI_MID || "15115304",
            maxItems: Number(process.env.WAR_THUNDER_BILIBILI_MAX_ITEMS || "4"),
            sourceLabel: "B站 SwordXue",
            game: "War Thunder",
            sourceType: "war-thunder-bilibili"
          });
        } catch {
          return fetchGoogleNewsItems({
            query: process.env.WAR_THUNDER_BILIBILI_QUERY || "site:bilibili.com/video SwordXue 战争雷霆",
            maxItems: 3,
            locale: "zh-CN",
            ceid: "CN:zh-Hans",
            sourceLabel: "B站 SwordXue",
            game: "War Thunder",
            excludeTerms
          });
        }
      },
      () => fetchGoogleNewsItems({
        query: process.env.WAR_THUNDER_FORUM_QUERY || 'site:forum.warthunder.com "Rumor Round-Up" War Thunder reliable leaked vehicle',
        maxItems: 2,
        locale,
        ceid,
        sourceLabel: "War Thunder 论坛传闻",
        game: "War Thunder",
        excludeTerms
      }),
      () => fetchSteamNewsItems({
        url: process.env.WARNO_STEAM_RSS || "https://store.steampowered.com/feeds/news/app/1611600/?cc=US&l=english",
        maxItems: 3,
        sourceLabel: "WARNO 官方 Steam 公告",
        game: "WARNO"
      })
    ];

    for (const job of curatedJobs) {
      try {
        for (const item of await job()) {
          if (!isFreshItem(item, maxAgeDays)) continue;
          const key = `${item.game}|${item.title}|${item.link}`.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          allItems.push(item);
        }
      } catch (error) {
        allItems.push({
          query: "curated-source",
          title: `Could not fetch curated game source: ${error.message}`,
          link: "",
          pubDate: new Date().toUTCString(),
          source: "local worker",
          sourceType: "error",
          description: error.message
        });
      }
    }

    return allItems;
  }

  for (const query of queries) {
    const url = buildGoogleNewsUrl(query, locale, ceid);
    try {
      const xml = await fetchRss(url);
      const items = parseRssItems(xml, url)
        .filter((item) => isFreshItem(item, maxAgeDays))
        .slice(0, maxPerQuery);
      for (const item of items) {
        if (shouldExcludeItem(item, excludeTerms)) continue;
        const key = `${item.title}|${item.link}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        allItems.push({ query, ...item });
      }
    } catch (error) {
      allItems.push({
        query,
        title: `Could not fetch game news for "${query}"`,
        link: "",
        pubDate: new Date().toUTCString(),
        source: "local worker",
        description: error.message
      });
    }
  }

  return allItems;
}
