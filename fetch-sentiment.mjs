// Scrapes the publicly visible XAU/USD sentiment numbers from tradersentiments.com
// and writes them to data/sentiment.json. Designed to run on a schedule via
// GitHub Actions (see .github/workflows/update-sentiment.yml).
//
// This is text-pattern based (not CSS-selector based) so it's more resilient to
// markup/class-name changes on their end - it looks for the same visible labels
// a human reading the page would see ("Average Long: 66%", "Crowd Bias: Bearish",
// broker rows like "Oanda / Bearish / Long: 77% Short: 23%").
//
// If the page structure changes enough that these patterns stop matching, the
// script exits with an error and leaves the existing data/sentiment.json alone,
// so the site keeps showing the last good snapshot instead of breaking.

import { writeFile, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "sentiment.json");

const SOURCE_URL = "https://tradersentiments.com/sentiment/commodities/xau-usd";
const PAIR = "XAU/USD";

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&rdquo;|&ldquo;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function extractOverview(text) {
  const longMatch = text.match(/Average Long:\s*(\d+)%/i);
  const shortMatch = text.match(/Average Short:\s*(\d+)%/i);
  const biasMatch = text.match(/Crowd Bias:\s*(Bullish|Bearish|Neutral)/i);

  if (!longMatch || !shortMatch || !biasMatch) {
    throw new Error(
      `Could not find overview sentiment fields. long=${!!longMatch} short=${!!shortMatch} bias=${!!biasMatch}`
    );
  }

  return {
    long: parseInt(longMatch[1], 10),
    short: parseInt(shortMatch[1], 10),
    bias: biasMatch[1],
  };
}

function extractBrokers(text) {
  const sectionMatch = text.match(/Broker breakdown([\s\S]*?)(?:What is Retail Sentiment|$)/i);
  const section = sectionMatch ? sectionMatch[1] : text;

  const rowRegex = /([A-Za-z][A-Za-z0-9]*)\n(Bullish|Bearish|Neutral)\nLong:\s*(\d+)%Short:\s*(\d+)%/g;

  const brokers = [];
  let m;
  while ((m = rowRegex.exec(section)) !== null) {
    brokers.push({
      name: m[1],
      bias: m[2],
      long: parseInt(m[3], 10),
      short: parseInt(m[4], 10),
    });
  }

  if (brokers.length === 0) {
    throw new Error("Could not find any broker breakdown rows.");
  }

  return brokers;
}

async function loadExisting() {
  try {
    const raw = await readFile(OUTPUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL, {
    headers: {
      // A normal browser UA - some sites block obvious bot user-agents.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching source page`);
  }

  const html = await res.text();
  const text = htmlToText(html);

  const overview = extractOverview(text);
  const brokers = extractBrokers(text);

  const data = {
    pair: PAIR,
    bias: overview.bias,
    long: overview.long,
    short: overview.short,
    brokers,
    source: SOURCE_URL,
    scrapedAt: new Date().toISOString(),
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log("Wrote", OUTPUT_PATH);
  console.log(JSON.stringify(data, null, 2));
}

main().catch(async (err) => {
  console.error("Scrape failed:", err.message);
  const existing = await loadExisting();
  if (existing) {
    console.error("Leaving existing data/sentiment.json untouched.");
  }
  process.exit(1);
});
