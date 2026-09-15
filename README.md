# CFTC COT Report Viewer

A single static HTML page that pulls live Commitments of Traders data directly
from the CFTC's public Socrata API (client-side, no backend needed) and shows
a color-coded long/short breakdown for Producer/Merchant, Swap Dealers,
Managed Money, Other Reportables, and a total "ALL" overview — with
week-over-week comparison, plus an XAU/USD retail sentiment card that
auto-updates on a schedule.

## Repo layout

```
your-repo/
├── index.html               <- the site itself
├── sentiment.json            <- auto-updated data the site reads
├── fetch-sentiment.mjs        <- scraper the workflow runs (Playwright-based)
├── package.json               <- declares the Playwright dependency
├── .gitignore
├── README.md
└── .github/
    └── workflows/
        └── update-sentiment.yml   <- MUST stay under .github/workflows/,
                                        that path is required by GitHub Actions
```

## Host it on GitHub Pages (free, ~2 minutes)

1. Create a new GitHub repo (public), e.g. `cftc-cot-report`.
2. Add this `index.html` to the repo root (just this one file is enough).
3. Push it:
   ```bash
   git init
   git add index.html
   git commit -m "Add CFTC COT report viewer"
   git branch -M main
   git remote add origin https://github.com/<your-username>/cftc-cot-report.git
   git push -u origin main
   ```
4. On GitHub: go to **Settings -> Pages**.
5. Under **Build and deployment**, set **Source: Deploy from a branch**,
   **Branch: main**, folder **/ (root)**. Save.
6. Wait ~1 minute, then your site is live at:
   `https://<your-username>.github.io/cftc-cot-report/`

That's it — no server, no build step, no secrets. The page calls the CFTC API
straight from the visitor's browser every time it loads, so the data is
always current (updated weekly by the CFTC, typically Fridays).

## If the CFTC API ever blocks browser requests (CORS)

Socrata (the platform CFTC's public API runs on) generally allows
cross-origin GET requests, so this should work as-is. If you ever see a CORS
error in the browser console, the fix is to switch to a "scheduled snapshot"
approach instead:
- Use the Python version (`cftc_cot_report.py`) in a GitHub Actions workflow
  that runs on a schedule (e.g. every Friday night) and writes the generated
  HTML into the repo / `gh-pages` branch.
- GitHub Pages then serves that pre-built snapshot instead of live-fetching
  in the browser.
Happy to build that workflow file too if you'd like the scheduled version
as a backup.

## Auto-updating XAU/USD retail sentiment (GitHub Actions)

The Swap Dealers table now sits side-by-side with an XAU/USD Retail Sentiment
card. That card reads from `sentiment.json` (same folder as `index.html`),
which a scheduled GitHub Actions workflow keeps fresh automatically:

- `fetch-sentiment.mjs` uses a **headless browser (Playwright)** to open
  tradersentiments.com's XAU/USD page and extracts the Long/Short percentages,
  crowd bias, and per-broker breakdown using text pattern matching (not
  brittle CSS selectors). A headless browser is needed - a plain HTTP fetch
  only sees the server-rendered overview stats; the per-broker breakdown
  table is loaded by client-side JavaScript after the page loads, so it's
  invisible to a plain fetch and only shows up once that JS actually runs.
- `package.json` declares the `playwright` dependency; the workflow runs
  `npm install` and caches the downloaded Chromium browser binary so most
  runs don't have to re-download it.
- `.github/workflows/update-sentiment.yml` runs that script on a schedule
  (every 5 minutes by default - GitHub's practical minimum) and commits the
  updated `sentiment.json` back to the repo if anything changed. (This one
  file has to stay under `.github/workflows/` - that path is required by
  GitHub Actions itself and can't be flattened, unlike everything else here.)
- `index.html` fetches `./sentiment.json` at page-load time and falls
  back to a built-in default snapshot if that file is ever missing.

**To enable it, after pushing these files to your repo:**
1. Go to **Settings -> Actions -> General**, and under "Workflow permissions"
   select **Read and write permissions** (needed so the workflow can commit
   the updated JSON back).
2. Go to the **Actions** tab, find "Update XAU/USD sentiment snapshot", and
   click **Run workflow** once manually to test it immediately rather than
   waiting for the next scheduled run.
3. Check the run logs - it prints the scraped values on success. If it
   fails, the logs now also print a debug snippet of the actual rendered
   page text, right above the error, which makes it much easier to spot
   wording/structure changes on their end.
4. Refresh your GitHub Pages site - the sentiment card will show
   "Auto-updated <timestamp> (hourly via GitHub Actions)" (the label still
   says "hourly" in the UI text even though the schedule is now 5 minutes -
   cosmetic only, doesn't affect functionality).

**Adjusting the schedule:** edit the `cron` line in the workflow file. GitHub
does not reliably run schedules more often than every 5 minutes, so
`"*/5 * * * *"` is effectively the fastest this can go. Cron times are in
UTC.

**If the scrape ever starts failing:** the script exits with an error,
prints what it actually saw on the page (first 3000 characters) to the
Action's log, and leaves the existing `sentiment.json` untouched - so the
site keeps showing the last good snapshot rather than breaking. Paste that
debug output if you need help adjusting the regex in `fetch-sentiment.mjs`.

## Using it

- Type a commodity name (e.g. `GOLD`, `SILVER`, `WTI CRUDE OIL`, `NATURAL GAS`)
  and click **Load Report**.
- Optionally pick an exact market from the dropdown (populated automatically
  after typing a commodity) if you want a specific contract like
  "GOLD - COMMODITY EXCHANGE INC." instead of the auto-picked main contract.
- Adjust **Weeks to show** to widen or narrow the comparison window.
