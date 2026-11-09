// Pulls automatic data into data/current.json:
//   • NPSG 7-Day Significant Fire Potential
//   • ERC / BI from a file uploaded to the uploads/ folder (newest file wins)
//   • SWA / OOA Type 1 IHC crews and Incident Management Teams from the SWCC SharePoint workbooks
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

const args = new Set(process.argv.slice(2));
const parts = ["outlook", "upload", "resources", "starts", "raws"];
const want = (k) => !parts.some((p) => args.has(`--${p}`)) || args.has(`--${k}`);
const dataFile = join(root, "data/current.json");
const state = JSON.parse(readFileSync(dataFile, "utf8"));
const stamp = () => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: C.autoData.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const g = (t) => f.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
};
let changed = 0, failed = 0;
const step = async (label, fn) => {
  try { await fn(); changed++; }
  catch (e) { failed++; console.error(`✗ ${label} not updated: ${e.message}`); }
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
    const rows = {};
    for (const p of C.psas) rows[p.ercId] = res.rows[p.ercId] || { ercVal: "", biVal: "", ercPct: "", biPct: "" };
    state.danger = { date: res.date || stamp().slice(0, 10), rows, source: `Uploaded file ${newest.f}`, fetchedAt: stamp(), fileVersion: `${newest.f}@${newest.t}` };
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
    state.crewsUpdated = stamp();
    state.crewsSource = { source: "SWCC SharePoint (auto)", fetchedAt: stamp(), lastUpdate: c.lastUpdate, ooaLastUpdate: c.ooaLastUpdate };
    console.log(`✓ Crews: ${c.crews.length} SWA, ${c.ooaCrews.length} OOA (sheet last update: ${c.lastUpdate || "not shown"})`);
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

if (want("starts")) await step("Fire starts (WFIGS)", async () => {
  const f = await FS.fetchStarts();
  state.fireStarts = { ...f, fetchedAt: stamp(), source: "WFIGS incident locations (auto)" };
  const y = f.daily[f.to];
  console.log(`✓ Fire starts ${f.from}…${f.to}: ${f.fires.length} in SW PSAs${f.placedByPsa ? "" : " (PSA outlines unavailable: AZ/NM by state)"}; ${f.to}: ${y.total} (lightning ${y.lightning}, human ${y.human}, unknown ${y.unknown})`);
});

let rawsStations = null;
const getStations = async () => (rawsStations = rawsStations || await RW.fetchStations());
if (want("raws")) await step("RAWS (FEMS weather obs)", async () => {
  const w = await RW.fetchRaws({ stations: await getStations() });
  state.raws = { ...w, fetchedAt: stamp() };
  console.log(`✓ RAWS ${w.date}: ${w.stations.length} stations in ${Object.values(w.byPsa).filter((x) => x.stations).length} PSAs`);
});

if (want("raws")) await step("FEMS ERC/BI (fuel model Y)", async () => {
  const n = await RW.fetchNfdr();
  state.femsNfdr = { ...n, fetchedAt: stamp() };
  const vals = Object.entries(n.byPsa).filter(([, x]) => x.stations).map(([k, x]) => `${k} ${x.erc}/${x.bi}`);
  console.log(`✓ FEMS ERC/BI ${n.date}: ${n.stations.length} stations; ERC/BI by PSA ${vals.join(", ")}`);
});

if (changed) {
  state.meta = { ...(state.meta || {}), asOf: stamp(), source: `automated pull ${stamp()}` };
  writeFileSync(dataFile, JSON.stringify(state, null, 1));
  const r = calc.compute(state);
  console.log(`PL${r.pl} (score ${r.score.toFixed(3)}) with ${state.preset} weights: ${r.elements.map((e) => `${e.name} ${e.rating}`).join("; ")}`);
}
if (!args.has("--no-archive")) {
  try {
    const runTime = stamp();
    const a = ARCHIVE.archiveRun({ root, state, result: calc.compute(state), runTime, C });
    console.log(`✓ Archived run ${runTime}: ${a.snapshot}; history ${a.runs} runs, ${a.days} days of fire starts, ${a.fires} fires, ${a.raws} RAWS rows, ${a.nfdr} FEMS ERC/BI rows`);
  } catch (e) { failed++; console.error(`✗ Archive not written: ${e.message}`); }
}
if (failed) console.error(`${failed} step(s) failed; the site keeps the last good data for those.`);
process.exit(failed && !changed ? 1 : 0);
