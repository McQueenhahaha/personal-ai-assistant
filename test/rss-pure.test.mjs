import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absoluteUrl,
  buildGoogleNewsUrl,
  decodeEntities,
  isFreshItem,
  parseItemDate,
  parseRssItems,
  shouldExcludeItem,
  slugTitle,
  stripTags,
  tagValue
} from "../src/rss.mjs";

const rssXml = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title><![CDATA[Patch &amp; Notes <b>Live</b>]]></title>
    <link>https://example.com/a?x=1&amp;y=2</link>
    <pubDate>Wed, 24 Jun 2026 10:30:00 GMT</pubDate>
    <source url="https://pcgamer.com">PC Gamer</source>
    <description><![CDATA[<p>Line <strong>one</strong> &amp; more</p>]]></description>
  </item>
  <item>
    <title>Fallback Source</title>
    <link>/relative</link>
    <pubDate>Invalid Date</pubDate>
    <description>No <em>source</em></description>
  </item>
  <item>
    <title>No link</title>
  </item>
</channel></rss>`;

test("entity and tag helpers keep current text normalization", () => {
  assert.equal(
    decodeEntities("<![CDATA[Rock &amp; Roll]]> &amp; &lt;tag&gt; &quot;quote&quot; &#39;apos&#39; &#x27;hex&#x27; &#33;"),
    "Rock & Roll & <tag> \"quote\" 'apos' 'hex' !"
  );
  assert.equal(
    stripTags(" <p>Alpha <strong>Beta &amp; <em>Gamma</em></strong></p><br> Delta "),
    "Alpha Beta & Gamma Delta"
  );
  assert.equal(
    tagValue("<item><title><![CDATA[Patch &amp; Notes <b>Live</b>]]></title></item>", "title"),
    "Patch & Notes Live"
  );
  assert.equal(tagValue("<item><title>Only title</title></item>", "description"), "");
});

test("URL and slug helpers keep full current strings", () => {
  assert.equal(
    buildGoogleNewsUrl("Escape from Tarkov patch", "en-AU", "AU:en"),
    "https://news.google.com/rss/search?q=Escape+from+Tarkov+patch&hl=en-AU&gl=AU&ceid=AU%3Aen"
  );
  assert.equal(
    absoluteUrl("https://warthunder.com/en/news/", "../news/9012-update-en?from=rss#top"),
    "https://warthunder.com/en/news/9012-update-en?from=rss#top"
  );
  assert.equal(slugTitle("/en/news/9012-development-roadmap-june-en"), "Development Roadmap June");
  assert.equal(slugTitle("/"), "");
});

test("date helpers keep current parse and freshness behavior", () => {
  assert.equal(
    parseItemDate({ pubDate: "Wed, 24 Jun 2026 10:30:00 GMT" }).toISOString(),
    "2026-06-24T10:30:00.000Z"
  );
  assert.equal(parseItemDate({ pubDate: "not a date" }), null);
  assert.equal(parseItemDate({}), null);

  const originalNow = Date.now;
  Date.now = () => new Date("2026-06-24T12:00:00Z").getTime();
  try {
    assert.equal(isFreshItem({ pubDate: "Wed, 24 Jun 2026 11:00:00 GMT" }, 1), true);
    assert.equal(isFreshItem({ pubDate: "Sat, 01 Jan 2000 00:00:00 GMT" }, 7), false);
    assert.equal(isFreshItem({ pubDate: "not a date" }, 7), false);
    assert.equal(isFreshItem({ pubDate: "not a date" }, 0), true);
    assert.equal(isFreshItem({ pubDate: "Thu, 25 Jun 2026 12:00:00 GMT" }, 7), false);
  } finally {
    Date.now = originalNow;
  }
});

test("parseRssItems keeps current item extraction behavior", () => {
  assert.deepEqual(parseRssItems(rssXml, "https://news.google.com/rss/search?q=tarkov"), [
    {
      title: "Patch & Notes Live",
      link: "https://example.com/a?x=1&y=2",
      pubDate: "Wed, 24 Jun 2026 10:30:00 GMT",
      source: "PC Gamer",
      description: "Line one & more"
    },
    {
      title: "Fallback Source",
      link: "/relative",
      pubDate: "Invalid Date",
      source: "news.google.com",
      description: "No source"
    }
  ]);
});

test("shouldExcludeItem keeps current exclude matching behavior", () => {
  assert.equal(
    shouldExcludeItem({ title: "Arena Sale Update", description: "Discount", source: "Store" }, []),
    false
  );
  assert.equal(
    shouldExcludeItem({ title: "Arena Sale Update", description: "Discount", source: "Store" }, ["sale"]),
    true
  );
  assert.equal(
    shouldExcludeItem({ title: "Patch Notes", description: "LIMITED discount", source: "Store" }, ["discount"]),
    true
  );
  assert.equal(
    shouldExcludeItem({ title: "Patch Notes", description: "Balance changes", source: "Official" }, ["sale"]),
    false
  );
});
