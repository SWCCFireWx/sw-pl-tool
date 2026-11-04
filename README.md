# SWA Preparedness Level (PL) Tool

A web version of the Southwest Area PL spreadsheet
(`2026_SWA_PL_Dashboard_V3_SHOULDER_SEASON_MASTER.xlsx`). Enter the five PL elements by hand and the
site calculates the Preparedness Level live. It is a plain static site (HTML, CSS, JavaScript, no build
step, no external libraries), so it runs on GitHub Pages or any web server, and can be opened offline.

## What's on the site

| Tab | Replaces sheet(s) | What you enter |
|---|---|---|
| PL Outcome | `PL_Outcome`, `PL_Outcome (2)` | Briefing date, preparer, notes. Shows the PL, score, and each element's contribution. |
| Fire Activity | `PL_worksheet` (Fire Activity) | Complex / T3 incident counts and the Fire Activity rating. A rating is suggested from the counts. |
| IMTs | `Teams_raw`, `IMT's` | Status of each team (AN, AG, AL, C, O-R, U, UE). |
| Crews | `Crews_raw`, `OOA Crews_raw`, `Crews` | Status and location of each SWA and out-of-area crew. |
| 7-Day Outlook | `SW_7-Day_ingest`, `7-Day_Dryness`, PL_worksheet chart | Pulled from NPSG automatically; cells can be overridden, or paste the 7-Day rows. |
| PSA ERCy | `NFDRSy_Ingest`, `PSA_ERCy_Values` | Previous-day FEMS ERCy/BIy averaged per PSA, pulled automatically; values can be overridden, or paste the NFDRS rows. |
| Model & Data | `MISC` | Weight preset (shoulder season / fire season / custom), save and load data files. |

## Put it on GitHub Pages

1. Create a repository (for example `swa-pl`) and upload every file in this folder, keeping the folder structure.
2. In the repository, go to **Settings → Pages**, set **Source** to *Deploy from a branch*, branch `main`, folder `/ (root)`, and save.
3. After a minute the site is live at `https://<your-org>.github.io/swa-pl/`.

To try it locally: run `python3 -m http.server` in this folder and open http://localhost:8000.
(Opening `index.html` directly also works, but then it can't read `data/current.json` and starts blank.)

## How data is saved and shared

- **Your edits** save automatically in your own browser. Nobody else sees them.
- **Published data** is `data/current.json`. Everyone who opens the site (and hasn't made their own edits)
  starts from this file.
- To publish a PL for everyone: **Model & Data → Download data file**, then replace `data/current.json`
  in the repository with it and commit. **Discard my edits, reload published data** brings a browser back
  in line with the published file.

## How the PL is calculated

Each element gets an adjective rating, which maps to a multiplier:

- Fire Activity, 7-Day trend, ERCy: Minimum 0 · Low 0.25 · Moderate 0.5 · High 0.75 · Maximum/Extreme 1
- IMT and crew **availability** (inverted): Maximum 0 · High 0.25 · Moderate 0.5 · Low 0.75 · Minimum 1

Contribution = element weight × multiplier. PL score = sum of contributions.
PL1 < 0.151 ≤ PL2 < 0.386 ≤ PL3 < 0.62 ≤ PL4 < 0.851 ≤ PL5.

| Element | Rule (from the workbook) |
|---|---|
| Fire Activity | Chosen by the user (guidance text and incident-count suggestion shown). |
| IMT Availability | CIMTs available: 0 → Minimum, 1–2 → Low, 3 → Moderate, 4+ → High, or Maximum if 4+ Type 3 teams also available. |
| Crew Availability | (available crews + crews prepositioned at SWCC) ÷ number of SWA crews: ≥100% Maximum, >60% High, >39% Moderate, >11% Low, else Minimum. |
| 7-Day trend | Daily score = sum of PSA levels (15–60). Average of 7 days: <25 Minimum, <37 Low, <46 Moderate, <52 High, else Maximum. |
| PSA ERCy | 8+ PSAs ≥97th → Extreme; any ≥97th → High; any 90–96th → Moderate; any 50–89th → Low; else Minimum. |

Weight presets:

| Preset | Fire | IMT | Crews | 7-Day | ERCy |
|---|---|---|---|---|---|
| Shoulder season (`PL_Outcome`) | 0.3 | 0 | 0 | 0.4 | 0.3 |
| Fire season (`PL_Outcome (2)`) | 0.2 | 0.2 | 0.1 | 0.3 | 0.2 |

All weights, thresholds, PSAs, rosters and status codes live in **`js/config.js`**. Edit that file to
change the model; the calculation code (`js/calc.js`) has no numbers of its own.

### Differences from the spreadsheet

The workbook had a few broken references and hard-coded values. The site does the following instead:

- IMT available counts are calculated from team status. In the workbook several were typed in
  (`IMT's!C31`, `C33`, `C35`, `PL_worksheet!H8`, `J9`) and some ranges were `#REF!`.
- Crew counts use the actual number of crews instead of a fixed 20, and ERCy percentages use the number
  of PSAs (15) instead of 16.
- Out-of-area crews with an available status (A, AG, AD) count toward total crew availability. The
  workbook only counted OOA crews prepositioned at SWCC. To match the workbook exactly, set
  `crewAvailability.includeOOAAvailable` to `false` in `js/config.js`.
- IMT commitment (`IMT's!D26`) uses "5 or more" committed CIMTs for Maximum (the workbook tested for exactly 5).
  It is shown for reference and is not part of the PL score, as in the workbook.

## Checking the math

`node tests/calc.test.js` runs the calculation engine against results from the workbook
(shoulder season seed → PL1 / 0.000; fire-season weights → PL2 / 0.250) and against each rating rule's boundaries.

## Exporting for email

The **Briefing & Export** tab shows a printable one-page-style PL briefing (PL and score, element table,
fire/IMT/crew summary, 7-Day count table and chart, PSA ERCy table and Fire Danger Metric, notes).

- **Save briefing as PDF** opens the browser's print window; choose *Save as PDF*. The print layout is Letter portrait.
- **Download Excel workbook** saves `SWA_PL_<date>_<time>.xlsx` with PL_Outcome, 7-Day, PSA_ERCy, IMTs, Crews,
  Fire_Activity and FEMS_Stations sheets, colored like the original spreadsheet.
- **Open email draft** starts an email with the PL summary in the body; attach the PDF or Excel file.
- **Latest scheduled report**: each scheduled run also saves `reports/SWA_PL_latest.pdf` and `.xlsx`, so there is
  always a ready-made file at `https://<your-org>.github.io/<repo>/reports/SWA_PL_latest.pdf`. It reflects the
  published data, not edits made in someone's browser.

## Automatic data

Two elements fill themselves in. Both can still be edited by hand, and the page shows where the
current numbers came from.

**7-Day Significant Fire Potential** comes from the NPSG 7-Day product's map service
(`fsapps.nwcg.gov/psp/arcgis/rest/services/npsg/outlooks_forecast/MapServer`, layers 0–6 = Day 1–7).
Each Southwest PSA gets a level: `drynesscode` 1 (little/no risk), 2 (low), 3 (moderate), or 4 (high risk)
when the PSA carries a CRITICAL burn environment or IGNITION trigger. Daily risk scores, the 7-day
average, and the chart (same layout as the PL_worksheet chart) follow.

**PSA ERCy / BIy** come from the public FEMS climatology API
(`fems.fs2c.usda.gov/api/climatology/graphql`, fuel model Y, observations only):

1. Stations for each PSA come from the NPSG Key RAWS layer (`PSA_GACC_KeyRAWS/MapServer/2`, field `NAT_CODE`).
   To use your own station lists, fill in `autoData.stationOverrides` in `js/config.js`.
2. For the previous day (America/Denver), each station's reading closest to 13:00 local time is used.
3. ERCy value and BIy value = the average over the PSA's reporting stations. The table shows stations reporting / listed.
4. Percentiles: each station's ERC and BI percentile levels come from FEMS climatology (5th–99th).
   The PSA's levels are the station levels averaged, and the PSA average value is placed on that scale.
   This is an approximation of a true PSA (SIG) climatology. It only has to be accurate enough to place each
   PSA in the <50 / 50–89 / 90–96 / 97+ bins the PL uses, but check it against your current percentile
   source before relying on it. FEMS uses its default climatology period (last 30 years, Apr 1–Oct 31,
   10:00–20:00) because the guide doesn't document how to change it.

**Where the pulls run**

- **Scheduled job (the reliable path).** `.github/workflows/update-data.yml` runs at **8:00 AM and
  9:00 PM Mountain Time (New Mexico)** year-round, adjusting for MDT/MST automatically (GitHub can start
  scheduled runs a few minutes late). It runs `node scripts/update-data.mjs`, which updates
  `data/current.json` and rebuilds station climatology (`data/fems-climatology.json`) every 30 days,
  then builds `reports/SWA_PL_latest.pdf` and `.xlsx`, and commits. GitHub Pages republishes, and
  everyone's page picks up the newer 7-Day and ERCy sections on their next visit.
  It runs automatically once the repo is on GitHub. To run it right away: **Actions → Update PL data → Run workflow**.
  (In **Settings → Actions → General**, workflow permissions must allow *Read and write*.)
- **In the browser.** The "Pull latest from NPSG" and "Pull previous day from FEMS" buttons, plus an
  automatic try when the page opens with old data, call the same code (`js/sources.js`) directly. This
  only works if NPSG and FEMS allow requests from your site's address (CORS). If they don't, the page
  says so and falls back to the copy the scheduled job saved.

Run it yourself with Node 18+: `node scripts/update-data.mjs` (add `--outlook`, `--danger`, or `--climatology`).
`node tests/sources.test.js` checks the parsing against canned responses.

IMT and crew status, and Fire Activity, are still entered by hand. `scripts/update-data.mjs` is the place
to add those sources later.

## Files

```
index.html            page
css/styles.css        styles (light and dark)
js/config.js          model settings, PSAs, rosters, status codes
js/calc.js            PL calculation engine (browser + Node)
js/app.js             user interface
data/current.json     published data (seeded from the 11/3–11/4/2026 workbook)
assets/psa-map.png    PSA reference map (from the workbook)
tests/calc.test.js    calculation checks
js/sources.js         NPSG 7-Day and FEMS pulls (browser + Node)
scripts/update-data.mjs, .github/workflows/update-data.yml   scheduled pull
data/fems-climatology.json   station percentiles (created by the first scheduled run)
js/export.js, js/xlsx-lite.js   briefing text and Excel export (no external libraries)
scripts/make-report.mjs        builds reports/SWA_PL_latest.pdf and .xlsx (uses Playwright)
reports/                       latest scheduled PDF and Excel briefing
tests/sources.test.js parsing checks for the automatic data
```
