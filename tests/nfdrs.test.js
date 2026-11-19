// Run with: node tests/nfdrs.test.js
// PSA ERCy/BI from the FEMS NFDR daily summary must match 2026_FEMS_NFDRSy_Processing_v2_USE_ON_DESKTOP.xlsx.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const N = require("../js/nfdrs-calc.js");
const C = require("../js/config.js");
const I = require("../js/erc-import.js")(C, require("../js/xlsx-read.js"));
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("ok -", name); };

// The workbook's results for Nov 17, 2026 ("NFDRSy Data copy to PL TOOL": ERCy avg, BI avg, ERCy pct, BI pct),
// within 0.1 (the site keeps ERC and BI to one decimal: stations rounded to 0.1 first, PSA averages rounded to 0.1).
// The percentiles here are the workbook's, made with its old Format-sheet table; with the ERC/BI BREAK POINTS
// tabs (now in use) SW-03's BI is 45th instead of 50th (34.24 is below that tab's 50th, 37.8). See BREAKPOINT_TABS below.
const WORKBOOK = {
  "SW-01": [15.3333, 11.2567, 45, 45], "SW-02": [20.6667, 16.7333, 45, 45], "SW-03": [35, 34.24, 45, 45],
  "SW-04": [18.3333, 16.1267, 45, 45], "SW-05": [13.3333, 11.0533, 45, 45], "SW-06N": [17, 16.685, 45, 45],
  "SW-06S": [19, 17.0225, 45, 45], "SW-07": [15.3333, 8.86, 45, 45], "SW-08": [19.75, 18.965, 45, 45],
  "SW-09": [20, 17.9733, 45, 45], "SW-10": [18.5, 13.545, 45, 45], "SW-11": [14.5, 7.18, 45, 45],
  "SW-12": [20.3333, 17.9367, 45, 45], "SW-13": [10, 11.77, 45, 45], "SW-14N": [8, 4.425, 45, 45],
};
const csv = fs.readFileSync(path.join(__dirname, "fixtures/fems-nfdr-daily-2026-11-17.csv"), "utf8");
// data/erc_bi_breakpoints.csv (edited by hand), or the built-in values from the workbook tabs when it isn't there yet
const bpPath = path.join(__dirname, "../data/erc_bi_breakpoints.csv");
const bpCsv = fs.existsSync(bpPath) ? fs.readFileSync(bpPath, "utf8") : N.breakpointsCsv(N.DEFAULT_BREAKPOINTS, "built in");
N.setBreakpoints(N.readBreakpointsCsv(bpCsv), "data/erc_bi_breakpoints.csv");

(async () => {
  await t("40 stations, Eight Mile Draw in SW-13 and SW-14N; the download link asks for all 40 (Batdraw included)", () => {
    assert.strictEqual(N.ALL_IDS.length, 40);
    assert.ok(N.STATIONS["SW-13"].some(([id]) => id === 292301) && N.STATIONS["SW-14N"].some(([id]) => id === 292301));
    const u = new URL(N.downloadUrl("2026-11-17"));
    assert.strictEqual(u.searchParams.get("stationIds").split(",").length, 40);
    assert.ok(u.searchParams.get("stationIds").split(",").includes("293101"));
    assert.deepStrictEqual([u.searchParams.get("startDate"), u.searchParams.get("fuelModels"), u.searchParams.get("dataset")], ["2026-11-17", "Y", "observation"]);
  });

  await t("Nov 17, 2026 FEMS daily summary gives exactly the workbook's ERCy/BI averages, and percentiles from the BREAK POINTS tabs, for all 15 PSAs", () => {
    const got = N.readCsv(csv);
    assert.strictEqual(got.date, "2026-11-17");
    assert.strictEqual(Object.keys(got.stations).length, 39); // Batdraw isn't in the workbook's pull
    const r = N.psaValues(got.stations, got.date);
    for (const [psa, [erc, bi, ep, bp]] of Object.entries(WORKBOOK)) {
      const x = r.rows[psa];
      assert.ok(Math.abs(x.ercVal - erc) <= 0.1 && Math.abs(x.biVal - bi) <= 0.1, `${psa} ${x.ercVal}/${x.biVal} vs ${erc}/${bi}`);
      assert.strictEqual(x.ercVal, Math.round(x.ercVal * 10) / 10); assert.strictEqual(x.biVal, Math.round(x.biVal * 10) / 10);
      assert.deepStrictEqual([x.ercPct, x.biPct], [ep, bp], psa);
    }
    assert.deepStrictEqual(r.rows["SW-14N"].missing, ["Batdraw"]);
  });

  await t("ERCy = ROUNDUP(sum)/n; BI = plain average; a station that didn't report is left out", () => {
    const st = { 20207: { erc: 15.67, bi: 8.7 }, 20212: { erc: 11.38, bi: 7.08 }, 20213: { erc: 18.7, bi: 17.99 } };
    assert.strictEqual(N.psaValues(st, "d").rows["SW-01"].ercVal, 15.3); // 15.7 + 11.4 + 18.7 = 45.8 → 46, / 3 = 15.33 → 15.3
    assert.strictEqual(N.psaValues(st, "d").rows["SW-01"].biVal, 11.3); // 8.7 + 7.1 + 18 = 33.8 / 3 = 11.27 → 11.3
    assert.deepStrictEqual(N.psaValues(st, "d").stations.filter((x) => x.psa === "SW-01").map((x) => x.erc), [15.7, 11.4, 18.7]);
    delete st[20212];
    const one = N.psaValues(st, "d").rows["SW-01"];
    assert.deepStrictEqual([one.ercVal, one.stations, one.missing], [17.5, 2, ["Dry Park"]]); // 15.7 + 18.7 = 34.4 → 35, / 2
    assert.strictEqual(N.roundUp(15.000000000002), 15);
    assert.strictEqual(N.roundUp(15.01), 16);
  });

  await t("percentiles follow the workbook's IF formulas at the BREAK POINTS tab values", () => {
    const b = N.BREAKPOINTS["SW-01"]; // ERCs 8/25: 50th 34.3, 75th 46.1, 85th 52.4, 90th 56.9, 97th 63.5; BI: 22.7 / 29 / 34.7 / 39.4
    assert.deepStrictEqual([34.2, 34.3, 46.1, 52.4, 56.9, 63.5, 70].map((v) => N.ercPercentile(v, b.erc)), [45, 50, 75, 85, 90, 97, 97]);
    assert.deepStrictEqual([22.6, 22.7, 29, 29.1, 34.7, 39.4].map((v) => N.biPercentile(v, b.bi)), [45, 50, 50, 75, 90, 97]);
    assert.deepStrictEqual([N.BREAKPOINTS["SW-07"].bi.p50, N.BREAKPOINTS["SW-07"].bi.p90], [23.5, 35]);
  });

  await t("breakpoints file: same values as the workbook tabs, edits take effect, mistakes are caught", () => {
    assert.deepStrictEqual(N.readBreakpointsCsv(bpCsv).warnings, []);
    const builtIn = N.breakpointsCsv(N.DEFAULT_BREAKPOINTS);
    assert.deepStrictEqual(N.readBreakpointsCsv(builtIn)["SW-14N"], N.DEFAULT_BREAKPOINTS["SW-14N"]);
    const edited = builtIn.replace(/^SW-01,ERC,11\.8,18\.7,24\.5,29\.6,34\.3,/m, "SW-01,ERC,11.8,18.7,24.5,29.6,14,");
    const t2 = N.readBreakpointsCsv(edited);
    assert.strictEqual(t2["SW-01"].erc.p50, 14);
    N.setBreakpoints(t2, "edited");
    assert.strictEqual(N.psaValues(N.readCsv(csv).stations, "2026-11-17").rows["SW-01"].ercPct, 50); // 15.33 ≥ 14
    N.setBreakpoints(N.readBreakpointsCsv(bpCsv), "data/erc_bi_breakpoints.csv");
    assert.ok(N.readBreakpointsCsv(builtIn.replace(/^SW-02,BI,(.*?),33\.3,/m, "SW-02,BI,$1,99,")).warnings.some((w) => /SW-02 BI .*out of order/.test(w)));
    assert.throws(() => N.readBreakpointsCsv(builtIn.split("\n").filter((l) => !l.startsWith("SW-05,ERC")).join("\n")), /SW-05 ERC missing/);
    assert.deepStrictEqual(N.readBreakpointsCsv(N.breakpointsCsv(N.DEFAULT_BREAKPOINTS))["SW-06S"], N.DEFAULT_BREAKPOINTS["SW-06S"]);
  });

  await t("the workbook's ERC BREAK POINTS / BI BREAK POINTS tabs are read (PSA 1 … PSA 6N, 6S … PSA 14)", () => {
    const hdr = ["ERCs 8/25", "10th", "20th", "30th", "40th", "50th", "60th", "70th", "75th", "80th", "85th", "90th", "95th", "97th"];
    const rows = (idx) => [hdr, ...Object.entries(N.DEFAULT_BREAKPOINTS).map(([psa, v]) => [psa.replace("SW-", "PSA ").replace(/PSA 0/, "PSA ").replace("14N", "14"), ...Object.values(v[idx])])];
    const t3 = N.readBreakpointTabs(rows("erc"), rows("bi"));
    assert.deepStrictEqual(t3["SW-06N"], N.DEFAULT_BREAKPOINTS["SW-06N"]);
    assert.deepStrictEqual(t3["SW-14N"], N.DEFAULT_BREAKPOINTS["SW-14N"]);
  });

  await t("an uploaded daily-summary CSV or the NFDRSy workbook is worked out the same way", async () => {
    const res = await I.importFile(new TextEncoder().encode(csv), "fems.csv");
    assert.ok(res.fromStations);
    assert.strictEqual(res.rows["SW-03"].ercVal, 35);
    assert.strictEqual(res.rows["SW-03"].biPct, 45);
    assert.strictEqual(res.date, "2026-11-17");
  });

  await t("dates as Excel serial numbers (an .xlsx upload) are read", () => {
    const rows = [["StationName", "ObservationTime", "NFDRType", "FuelModel", "ERC", "BI", "x"], ["SENATOR WASH", 46343, "O", "Y", 34.62, 34.24, 45801]];
    assert.strictEqual(N.readSummary(rows).date, "2026-11-17");
  });

  await t("FEMS forecast rows (NFDRType F) are read for the PL forecast, and left out of the observed values", async () => {
    const lines = csv.trim().split(/\r?\n/);
    const fc = [lines[0], ...lines.slice(1).map((l) => l.replace(",2026-11-17,O,", ",2026-11-20,F,"))].join("\n");
    const byDate = N.readSummaryByDate(N.csvRows(fc), { anyType: true });
    assert.ok(Object.keys(byDate["2026-11-20"] || {}).length >= 30, "forecast stations read");
    assert.strictEqual(Object.keys(N.readSummaryByDate(N.csvRows(fc))).every((d) => !Object.keys(N.readSummaryByDate(N.csvRows(fc))[d]).length), true, "observed-only reading skips them");
  });

  console.log(`\n${passed} NFDRS checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
