// Pulls the NPSG 7-Day outlook and previous-day FEMS ERCy/BIy into data/current.json.
// Run: node scripts/update-data.mjs            (both sources)
//      node scripts/update-data.mjs --outlook  (7-Day only)
//      node scripts/update-data.mjs --danger   (FEMS only)
//      node scripts/update-data.mjs --climatology  (force a refresh of station percentiles)
// Used by .github/workflows/update-data.yml. Needs Node 18+ (built-in fetch).
import { createRequire } from "module";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = require(join(root, "js/config.js"));
const S = require(join(root, "js/sources.js"))(C, globalThis.fetch);
const calc = require(join(root, "js/calc.js"))(C);

const args = new Set(process.argv.slice(2));
const want = (k) => !["--outlook", "--danger"].some((a) => args.has(a)) || args.has(`--${k}`);
const dataFile = join(root, "data/current.json");
const climFile = join(root, "data/fems-climatology.json");
const state = JSON.parse(readFileSync(dataFile, "utf8"));
const now = () => new Date().toISOString().slice(0, 16);
let changed = false, failed = 0;

if (want("outlook")) {
  try {
    const o = await S.fetchOutlook();
    state.outlook = o; changed = true;
    console.log(`7-Day outlook: ${o.startDate}${o.missing.length ? ` (${o.missing.length} PSA-days missing, set to 1)` : ""}`);
  } catch (e) { failed++; console.error(`7-Day outlook not updated: ${e.message}`); }
}

if (want("danger")) {
  try {
    let clim = existsSync(climFile) ? JSON.parse(readFileSync(climFile, "utf8")) : null;
    const ageDays = clim ? (Date.now() - new Date(clim.builtAt).getTime()) / 864e5 : Infinity;
    if (args.has("--climatology") || !clim || ageDays > C.autoData.fems.refreshClimatologyDays) {
      try {
        const stations = await S.fetchStations();
        clim = await S.fetchClimatology(stations);
        writeFileSync(climFile, JSON.stringify(clim, null, 1));
        console.log(`Station climatology refreshed: ${Object.keys(clim.byStation).length} stations`);
      } catch (e) { console.error(`Station climatology not refreshed (${e.message}); percentiles use the previous file if any.`); }
    }
    const d = await S.fetchDanger({ climatology: clim });
    if (!clim) console.error("No station climatology: ERCy/BIy percentiles left blank.");
    state.danger = d; changed = true;
    console.log(`FEMS ${d.date}: ${d.stations.filter((s) => s.erc !== "").length} stations reporting`);
  } catch (e) { failed++; console.error(`ERCy/BIy not updated: ${e.message}`); }
}

if (changed) {
  state.meta = { ...(state.meta || {}), source: `automated pull ${now()}Z` };
  writeFileSync(dataFile, JSON.stringify(state, null, 1));
  const r = calc.compute(state);
  console.log(`PL${r.pl} (score ${r.score.toFixed(3)}) with ${state.preset} weights`);
}
process.exit(failed && !changed ? 1 : 0);
