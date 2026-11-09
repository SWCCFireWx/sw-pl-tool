// Run with: node tests/sources.test.js
// Checks the NPSG 7-Day reader, the SharePoint crew/IMT reader and the ERC/BI file import
// against saved samples in tests/fixtures (no network needed).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const C = require("../js/config.js");
const makeSources = require("../js/sources.js");
const R = require("../scripts/lib/resources.cjs");
const I = require("../js/erc-import.js")(C, require("../js/xlsx-read.js"));
const calc = require("../js/calc.js")(C);
const fx = (f) => path.join(__dirname, "fixtures", f);

const day1 = Date.UTC(2026, 10, 9);
function arcFeatures(layer) {
  return C.psas.map((p, i) => ({ attributes: {
    nat_code: p.id, timestampdate: day1 + layer * 864e5, isvalid: 1,
    drynesscode: i < 3 ? 3 : i < 6 ? 2 : 1,
    type: i === 0 && layer === 2 ? "IGNITION" : i === 1 && layer === 3 ? "CRITICAL" : null,
  } }));
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

(async () => {
  // NPSG 7-Day
  const S = makeSources(C, async (url) => ok({ features: arcFeatures(+url.match(/MapServer\/(\d)\/query/)[1]) }));
  const o = await S.fetchOutlook();
  assert.strictEqual(o.startDate, "2026-11-09");
  assert.deepStrictEqual(o.values.SW01, [3, 3, 4, 3, 3, 3, 3]);
  assert.deepStrictEqual(o.values.SW02, [3, 3, 3, 4, 3, 3, 3]);
  console.log("ok - 7-Day levels: drynesscode 1-3, CRITICAL/IGNITION = 4");

  // SharePoint workbooks
  const cw = await R.parseCrewWorkbook(fs.readFileSync(fx("crews.xlsx")), C.autoData.sharepoint.crewSheets);
  assert.deepStrictEqual(cw.crews.map((c) => `${c.name}:${c.status}`), ["Aravaipa:A", "Black Mesa:C", "Blue Ridge:P", "Carson:UE"]);
  assert.strictEqual(cw.crews[2].location, "SWCC");
  assert.strictEqual(cw.crews[1].dateCom, "2026-11-02");
  assert.strictEqual(cw.lastUpdate, "11/3/2026 07:00");
  assert.deepStrictEqual(cw.ooaCrews.map((c) => `${c.name}:${c.status}:${c.location}`), ["Feather River:P:SWCC"]);
  const im = await R.parseImtWorkbook(fs.readFileSync(fx("imts.xlsx")), C.autoData.sharepoint.imtSheet);
  assert.deepStrictEqual(im.imts.map((t) => `${t.type}/${t.zone}/${t.ic}/${t.status}`), ["CIMT/1/Finch/AN", "CIMT/2/Truett/O-R", "3/CWZ/Stewart/UE", "3/GLZ/Cornwell/C"]);
  assert.strictEqual(im.lastUpdate, "0700 11/09/2026 DH");
  assert.strictEqual(R.downloadUrl("https://firenet365.sharepoint.com/:x:/s/S/IQDb?e=x&nav=y"), "https://firenet365.sharepoint.com/:x:/s/S/IQDb?download=1");
  console.log("ok - SharePoint crew and IMT tabs: headers found, separator rows skipped, Last Update read");

  // ERC/BI upload: NFDRSy_Ingest-style CSV
  const a = await I.importFile(fs.readFileSync(fx("nfdrs-ingest.csv")), "nfdrs-ingest.csv");
  assert.strictEqual(a.date, "2026-11-08");
  assert.deepStrictEqual(a.rows["SW-02"], { ercVal: 18, biVal: 16.3, ercPct: 52, biPct: 47, rowsUsed: 1, date: "2026-11-08" });
  assert.strictEqual(Object.keys(a.rows).length, 4);
  assert.strictEqual(a.missing.length, 11);
  const st = { ...require("../data/current.json") };
  st.danger = { rows: a.rows };
  assert.strictEqual(calc.dangerSummary(st.danger).rating, "High"); // SW-06N at 97th
  console.log("ok - ERC/BI CSV (NFDRSy_Ingest headers) read; SW-06N at 97th → High");

  // ERC/BI upload: station-level workbook, two days → latest day, averaged per PSA
  const b = await I.importFile(fs.readFileSync(fx("erc-bi-stations.xlsx")), "erc-bi-stations.xlsx");
  assert.strictEqual(b.date, "2026-11-08");
  assert.deepStrictEqual(b.rows["SW-01"], { ercVal: 25, biVal: 15, ercPct: 50, biPct: 40, rowsUsed: 2, date: "2026-11-08" });
  assert.strictEqual(b.rows["SW-06S"].ercPct, 92);
  console.log("ok - ERC/BI station workbook: latest date only, stations averaged per PSA, title rows skipped");

  // Pasted rows without a header, in NFDRSy_Ingest order
  const c = I.parseRows(I.parseCsv("SW-01\t9\t8\t45\t45\t11/3/2026\nSW 6N\t15\t14\t60\t55\t11/3/2026"));
  assert.strictEqual(c.rows["SW-06N"].ercPct, 60);
  assert.strictEqual(I.psaOf("sw-14n NE NM"), "SW-14N");
  console.log("ok - pasted rows without headers; PSA names like 'SW 6N' and 'sw-14n' recognised");
  console.log("\nsource checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
