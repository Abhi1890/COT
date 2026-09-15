// Scrapes the publicly visible XAU/USD sentiment numbers from tradersentiments.com
// and writes them to sentiment.json. Designed to run on a schedule via
// GitHub Actions (see .github/workflows/update-sentiment.yml).
//
// IMPORTANT: this uses a real headless browser (Playwright), not a plain fetch().
// The broker-breakdown table on that page is loaded by client-side JavaScript
// after the initial page load, so a plain HTTP fetch only ever sees the
// server-rendered overview stats (Average Long/Short/Bias) and never the
// per-broker rows. Rendering with a headless browser executes that JS first,
// same as a normal visitor's browser would.
//
// Extraction is still text-pattern based (not CSS-selector based) so it's more
// resilient to markup/class-name changes on their end - it looks for the same
// visible labels a human reading the page would see ("Average Long: 66%",
// "Crowd Bias: Bearish", broker rows like "Oanda / Bearish / Long: 77% Short: 23%").
//
// If the page structure changes enough that these patterns stop matching, the
// script exits with an error, prints a debug snippet of what it actually saw,
// and leaves the existing sentiment.json alone so the site keeps showing the
// last good snapshot instead of breaking.

import { chromium } from "playwright";
import { writeFile, readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "sentiment.json");

const SOURCE_URL = "https://tradersentiments.com/sentiment/commodities/xau-usd";
const PAIR = "XAU/USD";

function normalizeText(rawText) {
  return rawText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

function extractOverview(text) {
  const longMatch = text.match(/Average Long:\s*(\d+(?:\.\d+)?)%/i);
  const shortMatch = text.match(/Average Short:\s*(\d+(?:\.\d+)?)%/i);
  const biasMatch = text.match(/Crowd Bias:\s*(Bullish|Bearish|Neutral)/i);

  if (!longMatch || !shortMatch || !biasMatch) {
    throw new Error(
      `Could not find overview sentiment fields. long=${!!longMatch} short=${!!shortMatch} bias=${!!biasMatch}`
    );
  }

  return {
    long: parseFloat(longMatch[1]),
    short: parseFloat(shortMatch[1]),
    bias: biasMatch[1],
  };
}

function extractBrokers(text) {
  const sectionMatch = text.match(/Broker breakdown([\s\S]*?)(?:What is Retail Sentiment|$)/i);
  const section = sectionMatch ? sectionMatch[1] : text;

  // Tolerant of: broker names with spaces/periods/ampersands, decimal percentages,
  // and either "Long: 77%Short: 23%" (concatenated) or "Long: 77% Short: 23%" (spaced).
  const rowRegex =
    /([A-Za-z0-9][A-Za-z0-9 .&'-]{0,40}?)\n(Bullish|Bearish|Neutral)\nLong:\s*(\d+(?:\.\d+)?)%\s*Short:\s*(\d+(?:\.\d+)?)%/g;

  const brokers = [];
  let m;
  while ((m = rowRegex.exec(section)) !== null) {
    brokers.push({
      name: m[1].trim(),
      bias: m[2],
      long: parseFloat(m[3]),
      short: parseFloat(m[4]),
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

async function scrapePage() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    });
    console.log(`Navigating to ${SOURCE_URL} ...`);
    await page.goto(SOURCE_URL, { waitUntil: "networkidle", timeout: 45000 });

    // Give any client-side widgets a moment to finish fetching/rendering
    // their own data after the initial network-idle point.
    await page.waitForTimeout(2500);

    const rawText = await page.evaluate(() => document.body.innerText);
    return normalizeText(rawText);
  } finally {
    await browser.close();
  }
}

async function main() {
  const text = await scrapePage();

  let overview, brokers;
  try {
    overview = extractOverview(text);
    brokers = extractBrokers(text);
  } catch (err) {
    console.error(`--- DEBUG: total extracted text length = ${text.length} chars ---`);

    // Find every place the word "broker" appears (case-insensitive) and show
    // a window of surrounding text, since that's the part we actually need
    // to see to fix the regex - the first N characters alone often aren't enough.
    const lower = text.toLowerCase();
    let idx = 0;
    let hits = 0;
    while (hits < 5) {
      const found = lower.indexOf("broker", idx);
      if (found === -1) break;
      const start = Math.max(0, found - 100);
      const end = Math.min(text.length, found + 600);
      console.error(`--- DEBUG: context around "broker" occurrence #${hits + 1} (chars ${start}-${end}) ---`);
      console.error(text.slice(start, end));
      idx = found + 6;
      hits++;
    }
    if (hits === 0) {
      console.error('--- DEBUG: the word "broker" does not appear anywhere in the extracted text at all ---');
    }

    console.error("--- DEBUG: first 3000 chars of full extracted text (for overall context) ---");
    console.error(text.slice(0, 3000));
    console.error("--- END DEBUG ---");
    throw err;
  }

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
    console.error("Leaving existing sentiment.json untouched.");
  }
  process.exit(1);
});
