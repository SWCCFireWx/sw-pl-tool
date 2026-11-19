// Pulls automatic data into data/current.json:
//   • NPSG 7-Day Significant Fire Potential
//   • ERC / BI from a file uploaded to the uploads/ folder (newest file wins)
//   • SWA / OOA Type 1 IHC crews and Incident Management Teams from the SWCC SharePoint workbooks
//   • Fire Activity: active T3+ and T2+/complex incidents in the SW PSAs (WFIGS) → rating
//   • New wildfire starts (WFIGS) for the last 7 days, by cause and PSA
//   • Previous-day RAWS summaries per PSA (FEMS weather observations, every RAWS inside the SW PSAs)
//   • Previous-day fuel model Y ERC and BI per PSA from FEMS for the SWCC station list (archive only)
// then archives the run (data/archive/…).
// Run: node scripts/update-data.mjs                 (everything)
//      node scripts/update-data.mjs --outlook --upload --resources --starts --raws   (any subset)
//      add --no-archive to skip writing the archive
// Used by .github/workflows/update-data.yml. Needs Node 18+ (built-in fetch).
import { createRequire } from "module";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = require(join(root, "js/config.js"));
const S = require(join(root, "js/sources.js"))(C, globalThis.fetch);
const calc = require(join(root, "js/calc.js"))(C);
const R = require(join(root, "scripts/lib/resources.cjs"));
const I = require(join(root, "js/erc-import.js"))(C, require(join(root, "js/xlsx-read.js")));
const FS = require(join(root, "scripts/lib/firestarts.cjs")).makeFireStarts(C);
const RW = require(join(root, "scripts/lib/raws.cjs")).makeRaws(C);
const ARCHIVE = require(join(root, "scripts/lib/archive.cjs"));
const NF = require(join(root, "js/nfdrs-calc.js"));
const ACT = require(join(root, "scripts/lib/actualpl.cjs")).makeActualPl();
const { addDays: addDaysTo } = require(join(root, "scripts/lib/firestarts.cjs"));
// ERC/BI percentile breakpoints, edited by hand (or replaced by uploading the NFDRSy workbook to uploads/)
const bpFile = join(root, "data/erc_bi_breakpoints.csv");
if (!existsSync(bpFile)) { // put the file in place (from the workbook tabs built into js/nfdrs-calc.js) so it can be edited
  writeFileSync(bpFile, NF.breakpointsCsv(NF.DEFAULT_BREAKPOINTS, "ERC/BI BREAK POINTS tabs (8/25)"));
  console.log("· data/erc_bi_breakpoints.csv was missing; created it from the built-in ERC/BI BREAK POINTS (8/25)");
}
if (existsSync(bpFile)) {
  try {
    const warn = NF.setBreakpoints(NF.readBreakpointsCsv(readFileSync(bpFile, "utf8")), "data/erc_bi_breakpoints.csv");
    if (warn.length) console.log(`! Breakpoints: ${warn.join("; ")}`);
  } catch (e) { console.error(`✗ data/erc_bi_breakpoints.csv not used (${e.message}); using the built-in breakpoints`); }
}

const args = new Set(process.argv.slice(2));
const parts = ["outlook", "upload", "resources", "activity", "starts", "raws", "ercy", "forecast", "actual"];
const want = (k) => !parts.some((p) => args.has(`--${p}`)) || args.has(`--${k}`);
const dataFile = join(root, "data/current.json");
// data/current.json is the live data; if it's missing (new or reset repository) start from data/seed.json.
const seedFile = join(root, "data/seed.json");
if (!existsSync(dataFile)) console.log("· data/current.json not found; starting from data/seed.json");
const state = JSON.parse(readFileSync(existsSync(dataFile) ? dataFile : seedFile, "utf8"));
const stamp = () => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: C.autoData.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t) => f.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
};
let changed = 0, failed = 0;
// The season (shoulder / fire season) is switched by hand in data/season.txt: from the Run workflow form's
// "season" choice, or by editing the file on GitHub. Every run publishes with it. Without the file,
// js/config.js defaultPreset is used and the file is created.
const seasonFile = join(root, "data/season.txt");
const seasonOf = (t) => { const x = String(t || "").toLowerCase(); return /fire|^\s*season/.test(x) ? "season" : /shoulder/.test(x) ? "shoulder" : null; };
let seasonSwitched = false;
let season = existsSync(seasonFile) ? seasonOf(readFileSync(seasonFile, "utf8")) : null;
if (existsSync(seasonFile) && !season) console.log(`! data/season.txt says "${readFileSync(seasonFile, "utf8").trim()}"; use "shoulder" or "fire season". Using ${C.defaultPreset}.`);
if (!season) { season = C.defaultPreset; writeFileSync(seasonFile, `${season === "season" ? "fire season" : "shoulder"}\n`); }
if (state.preset !== season) {
  console.log(`· Season weights: ${C.weightPresets[season].label}${state.preset ? ` (was ${(C.weightPresets[state.preset] || {}).label || state.preset})` : ""}.`);
  if (state.preset && C.weightPresets[state.preset]) seasonSwitched = true;
  state.preset = season; delete state.weights; changed++;
}
// What each step did this run, for the Data Health tab (steps not run this time keep their last result).
const trigger = process.env.GITHUB_EVENT_NAME || "manual";
state.health = { run: stamp(), trigger, steps: { ...((state.health || {}).steps || {}) } };
const step = async (label, fn) => {
  const t0 = Date.now();
  try { await fn(); changed++; state.health.steps[label] = { ok: true, at: stamp(), secs: Math.round((Date.now() - t0) / 1000) }; }
  catch (e) { failed++; console.error(`✗ ${label} not updated: ${e.message}`); state.health.steps[label] = { ok: false, at: stamp(), msg: e.message, lastOk: ((state.health.steps[label] || {}).ok ? state.health.steps[label].at : (state.health.steps[label] || {}).lastOk) || "" }; }
};

if (want("outlook")) await step("7-Day outlook", async () => {
  const o = await S.fetchOutlook();
  state.outlook = o;
  console.log(`✓ 7-Day outlook: Day 1 ${o.startDate}${o.missing.length ? ` (${o.missing.length} PSA-days missing, set to 1)` : ""}`);
});

// ERC / BI: newest .xlsx / .csv in uploads/ (by last commit time, else file time). Applied once per file version.
if (want("upload")) {
  const dir = join(root, "uploads");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(xlsx|xlsm|csv|txt)$/i.test(f)) : [];
  const when = (f) => {
    try { return parseInt(execFileSync("git", ["log", "-1", "--format=%ct", "--", join("uploads", f)], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), 10) * 1000 || statSync(join(dir, f)).mtimeMs; }
    catch (e) { return statSync(join(dir, f)).mtimeMs; }
  };
  const newest = files.map((f) => ({ f, t: when(f) })).sort((a, b) => b.t - a.t)[0];
  if (!newest) console.log("· No ERC/BI file in uploads/; ERC/BI left as they are.");
  else if (state.danger && state.danger.fileVersion === `${newest.f}@${newest.t}`) console.log(`· ERC/BI: ${newest.f} already applied.`);
  else await step(`ERC/BI file ${newest.f}`, async () => {
    const res = await I.importFile(readFileSync(join(dir, newest.f)), newest.f);
    if (res.breakpoints) {
      writeFileSync(bpFile, NF.breakpointsCsv(res.breakpoints, `from ${newest.f}`));
      console.log(`✓ Breakpoints updated from ${newest.f} (ERC/BI BREAK POINTS tabs) → data/erc_bi_breakpoints.csv${res.bpWarnings.length ? `; check: ${res.bpWarnings.join("; ")}` : ""}`);
    }
    if (res.breakpointsOnly) { state.danger = { ...state.danger, fileVersion: `${newest.f}@${newest.t}` }; return; }
    const rows = {};
    for (const p of C.psas) rows[p.ercId] = res.rows[p.ercId] || { ercVal: "", biVal: "", ercPct: "", biPct: "" };
    state.danger = { date: res.date || stamp().slice(0, 10), rows, source: `Uploaded file ${newest.f}`, fetchedAt: stamp(), fileVersion: `${newest.f}@${newest.t}`,
      ...(res.stations ? { stations: res.stations, breakpoints: NF.BREAKPOINTS_SOURCE } : {}) };
    console.log(`✓ ERC/BI from ${newest.f}${res.sheet ? ` (sheet "${res.sheet}")` : ""}: ${Object.keys(res.rows).length} PSAs, ${res.rowsRead} rows, date ${res.date || "not given"}${res.missing.length ? `; missing ${res.missing.join(", ")}` : ""}`);
  });
}

if (want("resources")) {
  const sp = C.autoData.sharepoint;
  await step("Crews (SharePoint)", async () => {
    const c = await R.parseCrewWorkbook(await R.fetchWorkbook(sp.crewsUrl), sp.crewSheets);
    if (!c.crews.length) throw new Error(`no crews found on "${sp.crewSheets.swa}"`);
    state.crews = c.crews;
    state.ooaCrews = c.ooaCrews;
    state.t2iaCrews = c.t2iaCrews;
    state.crewsUpdated = stamp();
    state.crewsSource = { source: "SWCC SharePoint (auto)", fetchedAt: stamp(), lastUpdate: c.lastUpdate, ooaLastUpdate: c.ooaLastUpdate, t2iaLastUpdate: c.t2iaLastUpdate, t2iaSheet: c.t2iaSheet };
    console.log(`✓ Crews: ${c.crews.length} SWA, ${c.ooaCrews.length} OOA, ${c.t2iaCrews.length} SWA Type 2IA (sheet last update: ${c.lastUpdate || "not shown"})`);
    if (!c.t2iaSheet) console.log(`  ! No Type 2IA tab found. Tabs in the workbook: ${c.sheetNames.join(", ")}. Set autoData.sharepoint.crewSheets.t2ia in js/config.js to its name.`);
  });
  await step("IMTs (SharePoint)", async () => {
    const t = await R.parseImtWorkbook(await R.fetchWorkbook(sp.imtUrl), sp.imtSheet);
    if (!t.imts.length) throw new Error(`no teams found on "${sp.imtSheet}"`);
    state.imts = t.imts;
    state.imtsUpdated = stamp();
    state.imtsSource = { source: "SWCC SharePoint (auto)", fetchedAt: stamp(), lastUpdate: t.lastUpdate };
    console.log(`✓ IMTs: ${t.imts.length} teams (sheet last update: ${t.lastUpdate || "not shown"})`);
  });
}

if (want("activity") && (C.autoData.fireActivity || {}).auto) await step("Fire Activity (WFIGS active incidents)", async () => {
  const a = await FS.fetchActiveIncidents();
  const suggested = calc.largeFireRating(a.complex, a.t3);
  const { override, ...prev } = state.fire || {}; // a hand-picked rating lasts until the next automatic pull
  state.fire = { ...prev, rating: suggested, complex: a.complex, t3: a.t3, escapes: a.escapes, escapeList: a.escapeList, updated: stamp(), fetchedAt: stamp(),
    source: "WFIGS active incidents (auto)", incidents: a.incidents, activeTotal: a.activeTotal, unknownType: a.unknownType,
    byAcres: a.byAcres, noComplexity: a.noComplexity };
  if (a.byAcres.length) console.log(`  · Counted as T3 by size (no complexity in WFIGS or still Type 4/5): ${a.byAcres.map((i) => `${i.name} ${i.acres} ac`).join(", ")}`);
  console.log(`✓ Fire Activity inputs: ${a.complex} complex/T2+, ${a.t3} T3 active in SW PSAs (large-fire rating ${suggested}); ${a.escapes} escape(s)` +
    `${a.incidents.length ? ` (${a.incidents.slice(0, 8).map((i) => `${i.name} T${i.type}`).join(", ")})` : ""}; ${a.activeTotal} active incidents in all${a.unknownType ? `, ${a.unknownType} with no type` : ""}`);
});

if (want("starts")) await step("Fire starts (WFIGS)", async () => {
  // First run (no fire-start archive yet): fill in the whole year so the history chart has context.
  const firstRun = !existsSync(join(root, "data/archive/fire_starts_daily.csv"));
  const yesterday = FS.yesterday();
  const f = await FS.fetchStarts(firstRun || args.has("--backfill") ? { from: `${yesterday.slice(0, 4)}-01-01`, to: yesterday } : {});
  if (firstRun) console.log(`· First run: filled in fire starts from ${f.from}`);
  state.fireStarts = { ...f, fetchedAt: stamp(), source: "WFIGS incident locations (auto)" };
  const y = f.daily[f.to];
  console.log(`✓ Fire starts ${f.from}…${f.to}: ${f.fires.length} in SW PSAs${f.placedByPsa ? "" : " (PSA outlines unavailable: AZ/NM by state)"}; ${f.to}: ${y.total} (lightning ${y.lightning}, human ${y.human}, unknown ${y.unknown})`);
});

let rawsStations = null;
const getStations = async () => (rawsStations = rawsStations || await RW.fetchStations());
if (want("raws")) await step("RAWS + ASOS/AWOS weather obs", async () => {
  const w = await RW.fetchRaws({ stations: await getStations() });
  state.raws = { ...w, fetchedAt: stamp() };
  const dropped = w.checks.filter((c) => c.action === "dropped");
  const nA = w.stations.filter((x) => x.network === "ASOS/AWOS").length;
  console.log(`✓ Weather ${w.date}: ${w.stations.length - nA} RAWS + ${nA} ASOS/AWOS stations in ${Object.values(w.byPsa).filter((x) => x.stations).length} PSAs; quality checks removed ${dropped.length} reading(s)${w.checks.length > dropped.length ? `, flagged ${w.checks.length - dropped.length} to check` : ""}`);
  if (w.asosError) console.log(`  ! ASOS/AWOS not added: ${w.asosError}`);
  for (const c of w.checks.slice(0, 20)) console.log(`    ${c.psa} ${c.name || c.id}: ${c.field} ${c.value}${c.hour ? ` at ${c.hour}` : ""}, ${c.reason} (${c.action})`);
});

// Re-pull and re-check earlier days (e.g. after the quality checks change): --redo-weather-from=YYYY-MM-DD
const redoFrom = ([...args].find((a) => a.startsWith("--redo-weather-from=")) || "").split("=")[1];
if (redoFrom) await step(`Re-checking weather from ${redoFrom}`, async () => {
  const { addDays } = require(join(root, "scripts/lib/firestarts.cjs"));
  const last = addDays(new Intl.DateTimeFormat("en-CA", { timeZone: C.autoData.timeZone }).format(new Date()), -2);
  let asosStations = null;
  try { asosStations = await RW.fetchAsosStations(); } catch (e) { console.log(`  ! ASOS/AWOS station list: ${e.message}`); }
  for (let d = redoFrom; d <= last; d = addDays(d, 1)) {
    try {
      const w = await RW.fetchRaws({ date: d, stations: await getStations(), asosStations: asosStations || undefined });
      ARCHIVE.writeRaws(join(root, "data/archive"), w, stamp());
      const g = Object.entries(w.byPsa).filter(([, x]) => x.maxGust !== "").map(([k, x]) => `${k} ${x.maxGust}`).join(", ");
      console.log(`  ✓ ${d}: ${w.stations.length} stations, ${w.checks.filter((c) => c.action === "dropped").length} readings removed; max gusts ${g}`);
    } catch (e) { console.log(`  ✗ ${d}: ${e.message}`); }
  }
});

if (want("raws") || want("ercy")) await step("FEMS ERC/BI (fuel model Y)", async () => {
  const n = await RW.fetchNfdr();
  state.femsNfdr = { ...n, fetchedAt: stamp() };
  const vals = Object.entries(n.byPsa).filter(([, x]) => x.stations).map(([k, x]) => `${k} ${x.erc}/${x.bi}`);
  console.log(`✓ FEMS ERC/BI ${n.date}: ${n.stations.length} stations; ERC/BI by PSA ${vals.join(", ")}`);
});

// PSA ERCy and BI, worked out exactly like 2026_FEMS_NFDRSy_Processing_v2 (js/nfdrs-calc.js), from the FEMS NFDR
// daily summary for yesterday (each station's daily maximum, posted after midnight). If that download fails,
// the daily maximums from the FEMS pull above are used instead.
if (want("ercy")) await step("PSA ERCy/BI (FEMS daily summary, 40 stations)", async () => {
  const date = addDaysTo(new Intl.DateTimeFormat("en-CA", { timeZone: C.autoData.timeZone }).format(new Date()), -1);
  let got, how;
  try {
    const r = await fetch(NF.downloadUrl(date), { headers: { "User-Agent": "SWA-PL-tool (SWCC predictive services)", Accept: "text/csv,*/*" } });
    if (!r.ok) throw new Error(`FEMS answered ${r.status}`);
    got = NF.readCsv(await r.text());
    if (!Object.keys(got.stations).length) throw new Error("the download had no station rows");
    how = "FEMS NFDR daily summary (auto)";
  } catch (e) {
    const n = state.femsNfdr;
    if (!n || n.date !== date || !n.stations) throw new Error(`daily summary: ${e.message}; no FEMS daily maximums to fall back on`);
    console.log(`  ! Daily summary download failed (${e.message}); using the FEMS daily maximums instead`);
    const st = {};
    for (const x of n.stations) if (x.ercMax !== "" && x.ercMax !== undefined && x.psa !== "Other") st[x.id] = { id: x.id, name: x.name, erc: +x.ercMax, bi: x.biMax === "" ? null : +x.biMax, date };
    got = { date, stations: st, unknown: [] };
    how = "FEMS daily maximums (auto; daily summary unavailable)";
  }
  const res = NF.psaValues(got.stations, got.date || date);
  const prev = state.danger || {};
  if (prev.date && prev.date > res.date) { console.log(`  · Kept the uploaded ERC/BI for ${prev.date} (newer than ${res.date})`); return; }
  if (prev.date === res.date && /^Uploaded/.test(prev.source || "")) { console.log(`  · Kept the uploaded ERC/BI for ${prev.date}`); return; }
  const reporting = res.stations.filter((x) => x.reported).length;
  state.danger = { date: res.date, rows: res.rows, stations: res.stations, source: how, fetchedAt: stamp(), breakpoints: res.breakpoints };
  const missing = Object.entries(res.rows).filter(([, x]) => x.missing.length).map(([k, x]) => `${k}: ${x.missing.join(", ")}`);
  console.log(`✓ PSA ERCy/BI ${res.date}: ${new Set(res.stations.filter((x) => x.reported).map((x) => x.id)).size} of ${NF.ALL_IDS.length} stations (${reporting} PSA slots); ` +
    Object.entries(res.rows).map(([k, x]) => `${k} ${x.ercVal}/${x.ercPct}th`).join(", "));
  if (missing.length) console.log(`  ! Not reporting (left out of the average): ${missing.join("; ")}`);
});

// FEMS forecast ERC/BI for the next 6 days (same 40 stations, same calculation), for the PL forecast.
const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: C.autoData.timeZone }).format(new Date());
if (want("forecast")) await step("FEMS forecast ERC/BI (next 6 days)", async () => {
  const from = addDaysTo(todayLocal, 1), to = addDaysTo(todayLocal, 6);
  const r = await fetch(NF.downloadUrl(from, to, undefined, "Y", "forecast"), { headers: { "User-Agent": "SWA-PL-tool (SWCC predictive services)", Accept: "text/csv,*/*" } });
  if (!r.ok) throw new Error(`FEMS answered ${r.status}; the forecast carries today's ERCy forward`);
  const byDate = NF.readSummaryByDate(NF.csvRows(await r.text()), { anyType: true }); // forecast rows are NFDRType F
  const fd = {};
  for (const [d, st] of Object.entries(byDate)) if (d >= from && d <= to && Object.keys(st).length) {
    const v = NF.psaValues(st, d);
    fd[d] = { rows: v.rows, source: "FEMS forecast ERC/BI", stations: Object.keys(st).length };
  }
  if (!Object.keys(fd).length) throw new Error("FEMS returned no forecast ERC/BI; the forecast carries today's ERCy forward");
  state.forecastDanger = fd;
  console.log(`✓ FEMS forecast ERC/BI: ${Object.entries(fd).map(([d, x]) => `${d} (${x.stations} stations)`).join(", ")}`);
});

// The PL actually in effect (NICC, else the SWCC page), archived next to the forecasts made for that day.
if (want("actual")) await step("Actual SW PL (NICC / SWCC)", async () => {
  const a = await ACT.fetchActual();
  // An official PL typed into decisions/pl_reasons.csv for today wins (for days NICC doesn't list the GACCs).
  try {
    const rf = join(root, "decisions/pl_reasons.csv");
    if (existsSync(rf)) {
      const lines = readFileSync(rf, "utf8").split(/\r?\n/).filter((l) => l.trim());
      const hit = lines.slice(1).map((l) => l.split(",")).filter((c) => c[0] && c[0].trim() <= todayLocal && /^[1-5]$/.test((c[1] || "").trim())).sort((x, y) => (x[0] < y[0] ? -1 : 1)).pop();
      if (hit && hit[0].trim() === todayLocal) { a.pl = +hit[1].trim(); a.asOf = todayLocal; a.source = "decisions/pl_reasons.csv"; }
    }
  } catch (e) { console.log(`  ! decisions/pl_reasons.csv: ${e.message}`); }
  if (!a.pl && a.notListed && !(state.actualPl && state.actualPl.pl)) { // never read yet: start from the last published PL on file
    try {
      const pf = join(root, "data/archive/published_pl.csv");
      const last = existsSync(pf) ? readFileSync(pf, "utf8").split(/\r?\n/).slice(1).map((l) => l.split(",")).filter((c) => /^[1-5]$/.test((c[1] || "").trim()) && c[0] <= todayLocal).pop() : null;
      if (last) state.actualPl = { pl: +last[1], date: last[0], asOf: "", source: "SWCC published PL list", checkedAt: stamp() };
    } catch (e) { /* no list */ }
  }
  if (!a.pl && a.notListed && state.actualPl && state.actualPl.pl) {
    // NICC's GACC table is up but empty (it is in the off season) and SWCC shows the PL as a picture: the PL
    // hasn't been posted as changed, so the last official PL carries forward, marked as such.
    const prev = state.actualPl;
    state.actualPl = { ...prev, date: todayLocal, carried: true, carriedFrom: prev.carriedFrom || prev.date, source: prev.carried ? prev.source : `${prev.source}, carried forward`, checkedAt: stamp(), note: a.tried.join("; ") };
    console.log(`· Actual SW PL: NICC isn't listing the GACC PLs today; PL${prev.pl} carried forward from ${state.actualPl.carriedFrom}`);
    return;
  }
  if (!a.pl) {
    if (a.debug) writeFileSync(join(root, "data/archive/actual_pl_debug.txt"), `${stamp()}\n${a.tried.join("\n")}\n\n${a.debug}\n`);
    throw new Error(`couldn't read the Southwest PL (${a.tried.join("; ")}); what the pages looked like is in data/archive/actual_pl_debug.txt`);
  }
  state.actualPl = { pl: a.pl, date: todayLocal, asOf: a.asOf, source: a.source, checkedAt: stamp() };
  console.log(`✓ Actual SW PL: PL${a.pl} (${a.source}${a.asOf ? `, updated ${a.asOf}` : ""})`);
});

// ---------- backfill: re-pulling earlier days ----------
const ARCH_DIR = join(root, "data/archive");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const datesBetween = (a, b) => { const out = []; for (let d = a; d <= b; d = addDaysTo(d, 1)) out.push(d); return out; };
/* PSA ERC/BI for the given days from the FEMS daily summary (a month per download). Returns the days written. */
async function backfillErcy(dates) {
  const done = new Set();
  const sorted = [...dates].sort();
  for (let i = 0; i < sorted.length; ) {
    const d = sorted[i], end = [addDaysTo(d, 30), sorted[sorted.length - 1]].sort()[0];
    try {
      const r = await fetch(NF.downloadUrl(d, end), { headers: { "User-Agent": "SWA-PL-tool (SWCC predictive services)", Accept: "text/csv,*/*" } });
      if (!r.ok) throw new Error(`FEMS answered ${r.status}`);
      const byDate = NF.readSummaryByDate(NF.csvRows(await r.text()));
      for (const [day, st] of Object.entries(byDate).sort()) {
        if (day < d || day > end || !Object.keys(st).length || !dates.includes(day)) continue;
        const v = NF.psaValues(st, day);
        ARCHIVE.writeOutlookErcy(ARCH_DIR, { danger: { date: day, rows: v.rows, stations: v.stations, source: "FEMS NFDR daily summary (backfill)" } }, C);
        done.add(day);
      }
      console.log(`  ✓ ERC/BI ${d} to ${end}: ${Object.keys(byDate).length} days`);
    } catch (e) { console.log(`  ✗ ERC/BI ${d} to ${end}: ${e.message}`); }
    while (i < sorted.length && sorted[i] <= end) i++;
    await sleep(2000);
  }
  return done;
}
/* RAWS + ASOS/AWOS for the given days, re-pulled and re-checked. Returns the days written. */
async function backfillWeather(dates) {
  const done = new Set();
  let asosStations = null;
  try { asosStations = await RW.fetchAsosStations(); } catch (e) { console.log(`  ! ASOS/AWOS station list: ${e.message}`); }
  const stations = await getStations();
  for (const d of [...dates].sort()) {
    try {
      const w = await RW.fetchRaws({ date: d, stations, asosStations: asosStations || undefined });
      ARCHIVE.writeRaws(ARCH_DIR, w, stamp());
      done.add(d);
      console.log(`  ✓ ${d}: ${w.stations.length} stations, ${w.checks.filter((c) => c.action === "dropped").length} readings removed${w.asosError ? ` (ASOS/AWOS: ${w.asosError})` : ""}`);
    } catch (e) { console.log(`  ✗ ${d}: ${e.message}`); }
  }
  return done;
}
const yesterdayLocal = addDaysTo(todayLocal, -1);

// Manual: --backfill-from=YYYY-MM-DD [--backfill-what=all|ercy|weather] re-pulls every day from then to yesterday.
const bfFrom = ([...args].find((x) => x.startsWith("--backfill-from=")) || "").split("=")[1];
const bfWhat = ([...args].find((x) => x.startsWith("--backfill-what=")) || "=all").split("=")[1];
if (bfFrom && /^\d{4}-\d{2}-\d{2}$/.test(bfFrom)) {
  const days = datesBetween(bfFrom, yesterdayLocal);
  if (bfWhat === "all" || bfWhat === "ercy") await step(`ERC/BI back to ${bfFrom}`, async () => console.log(`✓ ERC/BI recalculated for ${(await backfillErcy(days)).size} days from ${bfFrom}`));
  if (bfWhat === "all" || bfWhat === "weather") await step(`Weather back to ${bfFrom}`, async () => console.log(`✓ Weather re-pulled for ${(await backfillWeather(days)).size} days from ${bfFrom}`));
}

// Automatic: fills in whatever is missing since autoData.backfill.from, a little each run, so the archive
// completes itself without holding up the scheduled updates (all ERC/BI at once; weather a month per run).
// A day that FEMS can't supply after 3 tries is left alone (listed on the Data Health tab).
const BF = C.autoData.backfill || {};
if (BF.from && !args.has("--no-backfill") && !bfFrom) {
  const statusFile = join(ARCH_DIR, "backfill_status.json");
  let status = {};
  try { status = JSON.parse(readFileSync(statusFile, "utf8")); } catch (e) { status = {}; }
  const have = (file, col = "date") => { try { return new Set(ARCHIVE.readTable(join(ARCH_DIR, file)).map((r) => r[col])); } catch (e) { return new Set(); } };
  const all = datesBetween(BF.from, addDaysTo(todayLocal, -2)); // yesterday comes from the regular steps
  const todo = (kind, haveSet, max) => all.filter((d) => !haveSet.has(d) && ((status[kind] || {})[d] || 0) < 3).slice(0, max);
  const mark = (kind, list, done) => { status[kind] = status[kind] || {}; for (const d of list) { if (done.has(d)) delete status[kind][d]; else status[kind][d] = (status[kind][d] || 0) + 1; } };
  const e = todo("ercy", have("ercy_psa_daily.csv"), 400);
  if (e.length) await step(`Filling in ERC/BI since ${BF.from}`, async () => { const done = await backfillErcy(e); mark("ercy", e, done); console.log(`✓ ERC/BI filled in for ${done.size} of ${e.length} missing days`); });
  const w = todo("weather", have("raws_daily.csv"), BF.weatherDaysPerRun || 30);
  if (w.length) await step(`Filling in weather since ${BF.from}`, async () => { const done = await backfillWeather(w); mark("weather", w, done); console.log(`✓ Weather filled in for ${done.size} of ${w.length} days (${w[0]} to ${w[w.length - 1]})`); });
  const left = (kind, setOf) => all.filter((d) => !setOf.has(d)).length;
  status.remaining = { ercy: left("ercy", have("ercy_psa_daily.csv")), weather: left("weather", have("raws_daily.csv")), from: BF.from, checked: stamp() };
  status.gaveUp = { ercy: Object.entries(status.ercy || {}).filter(([, n]) => n >= 3).map(([d]) => d), weather: Object.entries(status.weather || {}).filter(([, n]) => n >= 3).map(([d]) => d) };
  writeFileSync(statusFile, JSON.stringify(status, null, 1));
  state.health.backfill = status.remaining;
  state.health.backfillGaveUp = status.gaveUp;
}

const criteria = calc.criteriaVersion(NF.BREAKPOINTS);
{
  const prev = state.criteria || {};
  if (prev.fingerprint && prev.fingerprint !== criteria.fingerprint) {
    state.criteriaChanges = [...(state.criteriaChanges || []), { at: stamp(), from: prev.label, to: criteria.label, fromFingerprint: prev.fingerprint, toFingerprint: criteria.fingerprint, labelChanged: prev.label !== criteria.label }].slice(-20);
    console.log(`· Criteria changed (${prev.label} ${prev.fingerprint} → ${criteria.label} ${criteria.fingerprint})${prev.label === criteria.label ? ": the label in js/config.js wasn't changed" : ""}`);
  }
}
state.criteria = { ...criteria, breakpoints: NF.BREAKPOINTS_SOURCE };
// PL forecast: Day 1 (today) to Day 7 of this morning's 7-Day outlook
if (state.outlook && state.outlook.values) {
  state.forecast = { issued: stamp(), criteria, days: calc.forecast(state, { today: todayLocal }) };
  console.log(`✓ PL forecast (7-Day issued ${state.outlook.startDate}): ${state.forecast.days.map((f) => `Day ${f.outlookDay} ${f.date} PL${f.pl}`).join(", ")}`);
}

// The PL only changes when two scheduled runs in a row agree (plConfirm in js/config.js): one odd run, or a
// run started by hand or by an upload, can't move it on its own. The calculated PL is still shown and archived.
{
  const calcPl = calc.compute(state).pl, before = state.plConfirm;
  // A season switch is a decision, not a data blip: the PL for the new season applies right away.
  const pc = seasonSwitched ? calc.confirmPl(before, calcPl, { scheduled: true, now: stamp(), runsToAgree: 1 })
    : calc.confirmPl(before, calcPl, { scheduled: trigger === "schedule", now: stamp() });
  if (seasonSwitched) console.log(`· Season switched: the PL for ${C.weightPresets[state.preset].label} (PL${calcPl}) applies right away`);
  if (pc.changed) console.log(`✓ PL changes PL${before.pl} → PL${pc.pl}: ${seasonSwitched ? "season switched" : "scheduled runs agree"}`);
  else if (pc.pending) console.log(`· Calculated PL${calcPl}, but the PL stays PL${pc.pl} until more scheduled runs agree (${pc.pending.runs} so far${trigger === "schedule" ? "" : "; this run wasn't scheduled, so it doesn't count"})`);
  delete pc.changed;
  state.plConfirm = pc;
}

{
  // Store the full Fire Activity rating (large fires + IA load + capacity + 7-day trend) with the inputs.
  if (state.fire && state.fire.fetchedAt) {
    const f = calc.compute(state).fire;
    state.fire.startsAvg3 = f.startsAvg;
    state.fire.rating = f.rating;
    console.log(`✓ Fire Activity ${f.rating}: demand ${f.demand} (large fires ${f.large}, IA ${f.ia}: ${f.startsAvg ?? "–"} starts/day, ${f.escapes ?? "–"} escapes)${f.steps.map((x) => `; +1 ${x.why}`).join("")}`);
  }
  state.meta = { ...(state.meta || {}), asOf: stamp(), source: `automated pull ${stamp()}` };
  writeFileSync(dataFile, JSON.stringify(state, null, 1));
  const r = calc.compute(state);
  console.log(`PL${state.plConfirm.pl} · calculated PL${r.pl}${r.held ? ` (held at PL${r.pl}: no fire on the ground; score alone gives PL${r.scorePl})` : ""} (score ${r.score.toFixed(3)}) with ${state.preset} weights: ${r.elements.map((e) => `${e.name} ${e.rating}`).join("; ")}`);
}
if (args.has("--refresh-archive") && args.has("--no-archive")) {
  const f = ARCHIVE.refreshFromSnapshots({ root, calc, C });
  console.log(`✓ Archive: ${f.runs} runs re-scored with the current criteria`);
}
if (!args.has("--no-archive")) {
  try {
    const runTime = stamp();
    const a = ARCHIVE.archiveRun({ root, state, result: { ...calc.compute(state), pl: state.plConfirm.pl, plCalculated: calc.compute(state).pl, criteria, compare: { shoulder: calc.oldMethod(state, "shoulder"), season: calc.oldMethod(state, "season") }, alt: { with: calc.compute(state, { includeT2IA: true }), without: calc.compute(state, { includeT2IA: false }) } }, runTime, C });
    console.log(`✓ Archived run ${runTime}: ${a.snapshot}; history ${a.runs} runs, ${a.days} days of fire starts, ${a.fires} fires, ${a.raws} RAWS rows, ${a.nfdr} FEMS ERC/BI rows`);
  } catch (e) { failed++; console.error(`✗ Archive not written: ${e.message}`); }
  // Every run: re-score all archived runs with the current criteria (model_* columns) and fill gaps.
  try {
    const f = ARCHIVE.refreshFromSnapshots({ root, calc, C });
    console.log(`✓ Archive check: ${f.runs} runs re-scored with the current criteria (${f.updated} values filled or changed${f.missing ? `; ${f.missing} runs without a snapshot` : ""})`);
  } catch (e) { console.error(`✗ Archive refresh: ${e.message}`); }
}
if (failed) console.error(`${failed} step(s) failed; the site keeps the last good data for those.`);
process.exit(failed && !changed ? 1 : 0);
