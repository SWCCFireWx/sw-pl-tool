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

  // SharePoint anonymous download: cookie set on the redirect must be sent back to get the file
  const xlsx = fs.readFileSync(fx("imts.xlsx"));
  const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null, getSetCookie: () => o["set-cookie"] || [] });
  const fakeSp = async (url, opts) => {
    if (/download\.aspx\?share=/.test(url)) return { ok: false, status: 302, headers: hdrs({ location: "/sites/S/_layouts/15/guestaccess.aspx?x=1", "set-cookie": ["FedAuth=abc; path=/; secure", "rtFa=xyz; path=/"] }), arrayBuffer: async () => new ArrayBuffer(0) };
    if (/guestaccess/.test(url)) {
      const ok = /FedAuth=abc/.test(opts.headers.Cookie || "") && /rtFa=xyz/.test(opts.headers.Cookie || "");
      return ok ? { ok: true, status: 200, headers: hdrs({ "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), arrayBuffer: async () => xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.length) }
        : { ok: false, status: 403, headers: hdrs({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return { ok: true, status: 200, headers: hdrs({ "content-type": "text/html" }), arrayBuffer: async () => Buffer.from("<html><title>Sign in to your account</title></html>") };
  };
  const got = await R.fetchWorkbook("https://firenet365.sharepoint.com/:x:/s/S/EdKzToken?e=aw6fl7", fakeSp);
  assert.strictEqual((await R.parseImtWorkbook(got, C.autoData.sharepoint.imtSheet)).imts.length, 4);
  const signIn = async (url, opts) => ({ ok: true, status: 200, headers: hdrs({ "content-type": "text/html" }), arrayBuffer: async () => Buffer.from("<html><title>Sign in to your account</title></html>") });
  await assert.rejects(R.fetchWorkbook("https://firenet365.sharepoint.com/:x:/s/S/EdKzToken", signIn), /a sign-in page/);
  console.log("ok - SharePoint download keeps the access cookie across redirects; a sign-in page is reported clearly");

  // ERC/BI upload: NFDRSy_Ingest-style CSV
  const a = await I.importFile(fs.readFileSync(fx("nfdrs-ingest.csv")), "nfdrs-ingest.csv");
  assert.strictEqual(a.date, "2026-11-08");
  assert.deepStrictEqual(a.rows["SW-02"], { ercVal: 18, biVal: 16.3, ercPct: 52, biPct: 47, rowsUsed: 1, date: "2026-11-08" });
  assert.strictEqual(Object.keys(a.rows).length, 4);
  assert.strictEqual(a.missing.length, 11);
  const st = { ...require("./fixtures/state.json") };
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
  // SWA Type 2IA tab in the same crews workbook
  {
    const mk = require("../js/xlsx-lite.js");
    const tab = (first) => [[{ v: "Last Update: 11/19/26 0700" }], [], [first, "Current Type", "Home State", "Home Disp", "Home Unit", "Day Off", "Status", "Date Com", "Incident Dispatch/GACC", "Incident Name"],
      ...[["Alpha", "CRW1", "AZ", "PHC", "TNF", "Mon", "A"], ["Bravo", "CRW1", "NM", "ABC", "CNF", "Tue", "C", "", "SWCC", "Big Fire"]]];
    const t2 = [[{ v: "Last Update: 11/19/26 0730" }], [], ["SWA T2IA Crew", "Current Type", "Home State", "Home Disp", "Home Unit", "Day Off", "Status"],
      ["Gila T2IA", "CR2I", "NM", "SDC", "GNF", "Wed", "A"], ["Prescott T2IA", "T2IA", "AZ", "PDC", "PNF", "", "UE"]];
    const wb = mk([{ name: "SWA Type 1 IHC", cols: [], rows: tab("SWA Crew") }, { name: "OOA Type 1 IHC", cols: [], rows: tab("OOA Crew") }, { name: "SWA Type 2IA", cols: [], rows: t2 }]);
    const r = await R.parseCrewWorkbook(Buffer.from(wb), C.autoData.sharepoint.crewSheets);
    assert.deepStrictEqual([r.crews.length, r.ooaCrews.length, r.t2iaCrews.length, r.t2iaSheet], [2, 2, 2, "SWA Type 2IA"]);
    assert.deepStrictEqual([r.t2iaCrews[0].name, r.t2iaCrews[0].status, r.t2iaCrews[1].type], ["Gila T2IA", "A", "T2IA"]);
    const none = await R.parseCrewWorkbook(Buffer.from(mk([{ name: "SWA Type 1 IHC", cols: [], rows: tab("SWA Crew") }])), C.autoData.sharepoint.crewSheets);
    assert.deepStrictEqual([none.t2iaCrews.length, none.t2iaSheet], [0, ""]);
    console.log("ok - SWA Type 2IA tab read from the crews workbook (and its absence doesn't break the crews)");
  }
  // actual SW PL: NICC table and SWCC page
  {
    const A = require("../scripts/lib/actualpl.cjs");
    const nicc = '<h2>Current Preparedness Level</h2><p>Last Updated: Thursday, November 19, 2026 - 06:18</p><table><tr><th>Geographic Area</th><th>Preparedness Level</th></tr><tr><td>Alaska</td><td>1</td></tr><tr><td><a>Southwest</a></td><td> 3 </td></tr></table>';
    assert.deepStrictEqual(A.nicc(nicc), { pl: 3, asOf: "2026-11-19T06:18", notListed: false });
    assert.strictEqual(A.nicc("<p>Southwest Area (PL 2)</p>").pl, 2);
    assert.strictEqual(A.swcc('<img src="images/V_T1_Header_PreparednessLevel.gif"><img src="images/PL_4.gif"><img src="images/V_T1_Header_Notes.gif">').pl, 4);
    assert.strictEqual(A.swcc('<img src="images/V_T1_Header_PreparednessLevel.gif"><img src="x.gif"><img src="images/V_T1_Header_Notes.gif">').pl, null);
    const pages = { "https://www.nifc.gov/nicc": nicc };
    const got = await A.makeActualPl(async (u) => (pages[u] ? { ok: true, text: async () => pages[u] } : { ok: false, status: 404 })).fetchActual();
    assert.deepStrictEqual([got.pl, got.source], [3, "NICC (nifc.gov/nicc)"]);
    const fail = await A.makeActualPl(async () => ({ ok: true, text: async () => "<p>nothing</p>" })).fetchActual();
    assert.ok(fail.pl === null && fail.tried.length === 2 && fail.debug);
    console.log("ok - actual SW PL read from NICC's table (or the SWCC page); when neither can be read it says why");
  }
  {
    // NICC's GACC table with a header and no rows (the off season)
    const { nicc } = require("../scripts/lib/actualpl.cjs");
    const empty = nicc(`<h2>GACC Preparedness Levels</h2><table><thead><tr><th>Geographic Area</th><th>Preparedness Level</th></tr></thead><tbody></tbody></table><p>Last Updated: Thursday, November 19, 2026 - 06:18</p>`);
    assert.deepStrictEqual([empty.pl, empty.notListed, empty.asOf], [null, true, "2026-11-19T06:18"]);
    const full = nicc(`<table><tr><th>Geographic Area</th><th>Preparedness Level</th></tr><tr><td>Southwest</td><td>2</td></tr></table>`);
    assert.deepStrictEqual([full.pl, full.notListed], [2, false]);
    console.log("ok - an empty NICC GACC table is recognized (the last official PL carries forward)");
  }
  {
    // crew sheets with empty cells (holes) in the header area must not crash the reader
    const rows = [];
    rows[0] = []; rows[0][3] = "Last Update:"; rows[0][4] = "11/18/26";
    rows[2] = []; rows[2][0] = "SWA Crew"; rows[2][2] = "Status"; rows[2][4] = "Home State"; rows[2][5] = "Home Disp"; rows[2][7] = "Incident State"; // holes at 1, 3, 6
    rows[3] = ["Crew A", undefined, "A", undefined, "AZ", "PHC", undefined, ""];
    rows[4] = ["Crew B", undefined, "C-O", undefined, "NM", "SDC", undefined, "CA"];
    const buf = Buffer.from("x");
    const xr = require("../js/xlsx-read.js"), orig = xr.readXlsx;
    xr.readXlsx = async () => ({ "SWA Type 1 IHC": () => rows });
    try {
      const out = await R.parseCrewWorkbook(buf, { swa: "SWA Type 1 IHC", ooa: "OOA Type 1 IHC", t2ia: "SWA Type 2IA" });
      assert.deepStrictEqual(out.crews.map((c) => [c.name, c.status]), [["Crew A", "A"], ["Crew B", "C-O"]]);
    } finally { xr.readXlsx = orig; }
    console.log("ok - crew tabs with empty cells in the header rows are read (no 'startsWith' crash)");
  }
  console.log("\nsource checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
