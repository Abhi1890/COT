// Builds economic-events.json: important US economic events for
// Yesterday / Today / Tomorrow (in US Eastern time, matching how these
// releases are scheduled).
//
// Sources - all official, all free, no API key, no ToS ambiguity:
//   1. BLS release schedule (iCalendar feed) - the actual publication
//      calendar the BLS itself publishes for subscribing to in Google
//      Calendar/Outlook: https://www.bls.gov/schedule/news_release/bls.ics
//   2. BLS public data API - official "actual" values for CPI, Core CPI,
//      Unemployment Rate, Nonfarm Payrolls, Average Hourly Earnings.
//      https://api.bls.gov/publicAPI/v2/timeseries/data/
//   3. Federal Reserve Monetary Policy RSS feed - FOMC statements,
//      minutes, and related announcements.
//      https://www.federalreserve.gov/feeds/press_monetary.xml
//
// NOTE: unlike a forex-broker calendar, none of these sources publish a
// "forecast/consensus" figure - that concept only exists on private
// aggregator sites (which is also why we intentionally did NOT build
// this against Forex Factory). What you get here is the real release
// schedule plus the real official "actual" value once released.

import { writeFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "economic-events.json");

const BLS_ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const FED_RSS_URL = "https://www.federalreserve.gov/feeds/press_monetary.xml";
const BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";

// Maps a BLS release name (as it appears in their ICS SUMMARY field) to the
// specific data series worth showing as the "actual" figure once released.
const BLS_SERIES_BY_RELEASE = {
  "Employment Situation": [
    { id: "LNS14000000", label: "Unemployment Rate", unit: "%" },
    { id: "CES0000000001", label: "Nonfarm Payrolls", unit: "thousand jobs" },
    { id: "CES0500000003", label: "Avg Hourly Earnings", unit: "$" },
  ],
  "Consumer Price Index": [
    { id: "CUUR0000SA0", label: "CPI (All Items)", unit: "index" },
    { id: "CUSR0000SA0L1E", label: "Core CPI", unit: "index" },
  ],
};

function easternDateString(date) {
  // YYYY-MM-DD in US Eastern time - these releases are scheduled in ET,
  // so "today" needs to mean "today in ET" to line up correctly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function easternTimeString(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function getDateWindow() {
  const now = new Date();
  const offsetToDate = (offsetDays) =>
    easternDateString(new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000));
  return {
    yesterday: offsetToDate(-1),
    today: offsetToDate(0),
    tomorrow: offsetToDate(1),
  };
}

function parseICS(icsText) {
  const events = [];
  const blocks = icsText.split("BEGIN:VEVENT").slice(1);
  for (const block of blocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const dtstartMatch = block.match(/DTSTART[^:]*:(\d{8}T\d{6})/);
    if (!summaryMatch || !dtstartMatch) continue;

    const name = summaryMatch[1].trim();
    const raw = dtstartMatch[1]; // YYYYMMDDTHHMMSS, already in US-Eastern per TZID
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const hour24 = parseInt(raw.slice(9, 11), 10);
    const minute = raw.slice(11, 13);
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const ampm = hour24 < 12 ? "AM" : "PM";

    events.push({ name, date, time: `${hour12}:${minute} ${ampm} ET` });
  }
  return events;
}

function parseRSS(xmlText) {
  const items = [];
  const blocks = xmlText.split("<item>").slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    const linkMatch = block.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/s);
    const pubDateMatch = block.match(/<pubDate>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/pubDate>/s);
    if (!titleMatch || !pubDateMatch) continue;

    const pubDate = new Date(pubDateMatch[1].trim());
    if (isNaN(pubDate.getTime())) continue;

    items.push({
      name: titleMatch[1].trim(),
      date: easternDateString(pubDate),
      time: `${easternTimeString(pubDate)} ET`,
      link: linkMatch ? linkMatch[1].trim() : null,
    });
  }
  return items;
}

async function fetchBlsActuals(seriesIds) {
  if (seriesIds.length === 0) return {};
  const year = new Date().getFullYear();
  const res = await fetch(BLS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...BROWSER_HEADERS },
    body: JSON.stringify({
      seriesid: seriesIds,
      startyear: String(year - 1),
      endyear: String(year),
    }),
  });
  if (!res.ok) throw new Error(`BLS API HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "REQUEST_SUCCEEDED") {
    throw new Error(`BLS API: ${JSON.stringify(data.message || data.status)}`);
  }

  const bySeriesId = {};
  for (const series of data.Results?.series || []) {
    // BLS returns each series' data points newest-first.
    const latest = series.data?.[0];
    if (latest) {
      bySeriesId[series.seriesID] = { value: latest.value, period: `${latest.periodName} ${latest.year}` };
    }
  }
  return bySeriesId;
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/calendar, application/xml, text/xml, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.bls.gov/schedule/news_release/",
};

async function main() {
  let icsText = null;
  let rssText = null;

  try {
    const res = await fetch(BLS_ICS_URL, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    icsText = await res.text();
  } catch (err) {
    console.error("Warning: could not fetch BLS release schedule:", err.message);
  }

  try {
    const res = await fetch(FED_RSS_URL, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rssText = await res.text();
  } catch (err) {
    console.error("Warning: could not fetch Fed RSS feed:", err.message);
  }

  if (!icsText && !rssText) {
    throw new Error("Both BLS and Fed sources failed - nothing to update.");
  }

  const { yesterday, today, tomorrow } = getDateWindow();
  const windowDates = new Set([yesterday, today, tomorrow]);

  const blsEvents = icsText ? parseICS(icsText).filter((e) => windowDates.has(e.date)) : [];
  const fedEvents = rssText ? parseRSS(rssText).filter((e) => windowDates.has(e.date)) : [];

  // Only fetch "actual" values for releases whose date is today or earlier
  // (a future release obviously has no actual value yet), and only for
  // releases we have a series mapping for.
  const neededSeriesIds = new Set();
  for (const event of blsEvents) {
    if (event.date > today) continue;
    const defs = BLS_SERIES_BY_RELEASE[event.name];
    if (defs) defs.forEach((d) => neededSeriesIds.add(d.id));
  }

  let actualsBySeriesId = {};
  try {
    actualsBySeriesId = await fetchBlsActuals([...neededSeriesIds]);
  } catch (err) {
    // Don't let a BLS API hiccup take down the whole schedule - the
    // schedule itself (from the ICS feed) is the more important part.
    console.error("Warning: could not fetch BLS actual values:", err.message);
  }

  for (const event of blsEvents) {
    const defs = BLS_SERIES_BY_RELEASE[event.name];
    if (!defs || event.date > today) continue;
    const actuals = defs
      .map((d) => {
        const result = actualsBySeriesId[d.id];
        return result ? { label: d.label, value: result.value, unit: d.unit, period: result.period } : null;
      })
      .filter(Boolean);
    if (actuals.length) event.actual = actuals;
  }

  const events = [
    ...blsEvents.map((e) => ({ ...e, source: "BLS" })),
    ...fedEvents.map((e) => ({ ...e, source: "Federal Reserve" })),
  ].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const output = {
    generatedAt: new Date().toISOString(),
    dateRange: { yesterday, today, tomorrow },
    events,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${events.length} events (${yesterday} to ${tomorrow}) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Failed to build economic events:", err);
  process.exit(1);
});
