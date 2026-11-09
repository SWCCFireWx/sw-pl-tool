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
| IMTs | `Teams_raw`, `IMT's` | Read from the SWCC SharePoint "Incident Management Teams" tab twice a day; can be edited. |
| Crews | `Crews_raw`, `OOA Crews_raw`, `Crews` | Read from the SWCC SharePoint "SWA Type 1 IHC" and "OOA Type 1 IHC" tabs twice a day; can be edited. |
| 7-Day Outlook | `SW_7-Day_ingest`, `7-Day_Dryness`, PL_worksheet chart | Pulled from NPSG automatically; cells can be overridden, or paste the 7-Day rows. |
| PSA ERCy | `NFDRSy_Ingest`, `PSA_ERCy_Values` | Upload the day's ERC/BI file (.xlsx or .csv), paste rows, or type ERCy/BIy values and percentiles. |
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
- **Download Excel workbook** saves `SWA_PL_<date>_<time>.xlsx` with PL_Outcome, 7-Day, PSA_ERC, IMTs, Crews
  and Fire_Activity sheets, colored like the original spreadsheet.
- **Open email draft** starts an email with the PL summary in the body; attach the PDF or Excel file.
- **Latest scheduled report**: each scheduled run also saves `reports/SWA_PL_latest.pdf` and `.xlsx`, so there is
  always a ready-made file at `https://<your-org>.github.io/<repo>/reports/SWA_PL_latest.pdf`. It reflects the
  published data, not edits made in someone's browser.

## Automatic data

The 7-Day outlook, crews and IMTs fill themselves in at **8:00 AM and 9:00 PM Mountain Time (New Mexico)**.
ERC/BI come from a file you upload. Everything can still be edited by hand, and each tab shows where its
numbers came from and when.

**7-Day Significant Fire Potential**: the NPSG 7-Day product's map service
(`fsapps.nwcg.gov/psp/arcgis/rest/services/npsg/outlooks_forecast/MapServer`, layers 0–6 = Day 1–7).
Each Southwest PSA gets a level: `drynesscode` 1 (little/no risk), 2 (low), 3 (moderate), or 4 (high risk)
when the PSA carries a CRITICAL burn environment or IGNITION trigger.

**ERC / BI upload**: two ways, same file.

- **On the site** (PSA ERCy tab → *Upload ERC/BI file*, or drag the file onto it): fills the table right away,
  in your browser only.
- **For everyone**: upload the file to the repository's `uploads/` folder (**Add file → Upload files**).
  That starts the workflow, which applies the newest file in `uploads/` to `data/current.json` and rebuilds
  the PDF/Excel briefing; the site shows it a couple of minutes later.

The file can be `.xlsx` or `.csv` (old `.xls` must be re-saved). It needs a PSA column (SW01 … SW14N,
SW-01, "SW 6N" all work) and ERC and/or BI columns. Columns are found by their headers, so
`PSA Avg | ERCy Avg | BI Avg | ERCy Percentile | BI Percentile | ObsDate` (the NFDRSy_Ingest layout) works,
as does a station-level export with a PSA column: several rows per PSA are averaged, using each PSA's latest
date. Without a header row the order PSA, ERCy, BI, ERCy %, BI %, date is assumed. The import says how many
PSAs it found and which are missing; the PL needs the ERCy percentile column to rate fire danger.

**Crews and IMTs**: the SWCC FireNet SharePoint workbooks, which are shared with "anyone with the link":

- Crews: "SWA CREWS and MODULES", tabs **SWA Type 1 IHC** and **OOA Type 1 IHC**.
- IMTs: tab **Incident Management Teams**.

The job downloads each workbook (the sharing link with `?download=1`), finds the header row by its column
names (SWA CREW, CURRENT TYPE*, HOME STATE, …, STATUS, …, INCIDENTDISP_GACC, INCIDENT NAME, REMARKS for
crews; MOB LOCATION, TYPE, NBR_ZONE, INCIDENT COMMANDER, HOME DISPATCH, STATUS, … for IMTs), skips the
`------` separator rows, and reads the sheet's "Last Update:" text, which the tabs display. A crew with
status P counts as available when its INCIDENTDISP_GACC is SWCC, as in the spreadsheet. Links, tab names
and the header names it recognizes are in `js/config.js` and `scripts/lib/resources.cjs`.
If a sharing link stops being public, the job log says SharePoint returned a sign-in page.

**Where the pulls run**

- **Scheduled job.** `.github/workflows/update-data.yml` runs at 8:00 AM and 9:00 PM Mountain Time year-round,
  adjusting for MDT/MST automatically (GitHub can start scheduled runs a few minutes late). It runs
  `node scripts/update-data.mjs`, which updates `data/current.json`, then builds `reports/SWA_PL_latest.pdf`
  and `.xlsx`, and commits. GitHub Pages republishes, and everyone's page picks up the newer data on their
  next visit. If one source fails, the others still update and the failed one keeps its last good data.
  To run it right away: **Actions → Update PL data → Run workflow**. (In **Settings → Actions → General**,
  workflow permissions must allow *Read and write*.)
- **In the browser.** The 7-Day tab has a "Pull latest from NPSG" button, and the page tries it when it
  opens with old data. This only works if NPSG allows requests from your site (CORS); if not, the page says
  so and uses the copy the scheduled job saved. SharePoint can only be read by the scheduled job.

Run it yourself with Node 18+: `node scripts/update-data.mjs` (add `--outlook`, `--upload`, `--resources`, `--starts` or `--raws` for one part, `--no-archive` to skip archiving).
`node tests/sources.test.js` checks the readers against saved samples in `tests/fixtures/`.

Fire Activity is still entered by hand.

## Archive and database

Every run (8 AM, 9 PM, manual, or an ERC/BI upload) is archived in `data/archive/`, building a record to
check the PL calculation against what actually happened:

| File | One row per | Contents |
|---|---|---|
| `history.csv` | run | PL, score, weights, each element's rating, inputs and contribution, the sheets' Last Update, previous-day starts and RAWS summary, link to the snapshot |
| `fire_starts_daily.csv` | day | New wildfire starts by cause (lightning, human, unknown), acres, and starts per PSA |
| `fire_starts.csv` | fire | WFIGS id, discovery date/time, name, cause (as reported and grouped), acres, state, dispatch, PSA, lat/lon |
| `fems_erc_bi_daily.csv` | day and PSA | FEMS fuel model Y ERC and BI from the SWCC station list: stations reporting, 13:00 values and daily max, averaged per PSA |
| `fems_erc_bi_stations.csv` | day and station | The same for each listed station |
| `raws_daily.csv` | day and PSA | RAWS stations reporting, average max temperature, average and lowest min RH, max gust, average precipitation, stations with wetting rain (≥ 0.10 in) |
| `snapshots/YYYY/YYYY-MM-DD_HHMM.json` | run | The full data behind that run's PL |

The CSVs open in Excel and can be downloaded from the **History & Data** tab, which also shows yesterday's
starts and RAWS, a chart of the morning PL score against daily starts, and a table of average starts per day
for each PL (or each element's rating), with the correlation between score and starts. Over a season this
shows whether higher PLs actually line up with more fire activity, and which element is pulling its weight.

**Fire starts** come from the NIFC WFIGS incident locations layer (year to date), wildfires only (type WF),
in AZ, NM, TX and OK, then kept only if the point of origin falls inside a Southwest PSA (outlines from the
NPSG map service), so West Texas and the Oklahoma panhandle count only where they're in SWA PSAs. Causes:
Natural → lightning, Human → human, everything else (Undetermined, Unknown, blank) → unknown. Each run
re-counts the last 7 days because incidents are often entered late.

**RAWS weather** comes from FEMS public weather observations (`weatherObs` on fems.fs2c.usda.gov, no key
needed) for as many stations as are available: every RAWS FEMS lists in AZ, NM, TX and OK (`stationMetaData`),
kept if its latitude/longitude falls inside a Southwest PSA. For the previous local day the job takes each
station's hourly observations (forecast rows and readings FEMS flags as suspicious are dropped) and keeps
max temperature, min RH, max peak gust (max sustained wind if no gust is reported) and the 24-hour
precipitation total, then summarizes by PSA. The table shows stations reporting / stations in the PSA.

**FEMS ERC and BI (archive only)** come only from the SWCC ERC station list, set in
`autoData.raws.nfdrStationsByPsa` in `js/config.js` (Eight Mile Draw counts in both SW13 and SW14N, as SWCC
lists it; the four "Other" stations are archived individually but not averaged into a PSA). Previous-day
NFDRS fuel model Y observations (`nfdrsObs`): per station the reading closest to 13:00 local time and the
day's highest ERC and BI, averaged per PSA into `fems_erc_bi_daily.csv`, station by station into
`fems_erc_bi_stations.csv`, and into the history (`fems_erc_avg`, `fems_bi_avg`, `fems_erc_highest_psa`,
`fems_bi_highest_psa`). These are kept for comparison; the PL's Fire Danger element still uses the ERC/BI
file you upload, with its percentiles.

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
js/sources.js         NPSG 7-Day reader (browser + Node)
js/erc-import.js, js/xlsx-read.js   ERC/BI file import and .xlsx reader (browser + Node, no libraries)
scripts/lib/          SharePoint workbook download and crew/IMT reader
uploads/              put the day's ERC/BI file here to update the site for everyone
scripts/lib/firestarts.cjs, raws.cjs, archive.cjs   fire starts, RAWS and the archive
data/archive/         the archive and CSV database (written by the scheduled job)
tests/archive.test.js checks for fire starts, RAWS and the archive
scripts/update-data.mjs, .github/workflows/update-data.yml   scheduled pull
tests/fixtures/       sample SharePoint workbooks and ERC/BI files used by the tests
js/export.js, js/xlsx-lite.js   briefing text and Excel export (no external libraries)
scripts/make-report.mjs        builds reports/SWA_PL_latest.pdf and .xlsx (uses Playwright)
reports/                       latest scheduled PDF and Excel briefing
tests/sources.test.js parsing checks for the automatic data
```
