/*
 * PSA ERCy / BI from FEMS: the calculation in 2026_FEMS_NFDRSy_Processing_v2_USE_ON_DESKTOP.xlsx, automated.
 *
 * Source: the FEMS NFDR daily summary (fuel model Y, observed), the same download the workbook's
 * "START HERE Data Pull URL" tab uses. ERC and BI are each station's daily maximum, available after
 * midnight for the day before.
 *
 * Every ERC and BI value is kept to one decimal: each station's daily value is rounded to 0.1 when it's read,
 * and each PSA's average is rounded to 0.1 before its percentile is looked up.
 * Per PSA (the "Calc PSA Average ERCy&BI" tab):
 *   ERCy Avg = ROUNDUP(sum of the PSA's station ERCs, 0) / number of stations, to 0.1
 *   BI Avg   = sum of the PSA's station BIs / number of stations, to 0.1
 * A station that didn't report is left out of the average (and listed), instead of counting as 0.
 *
 * Percentiles: the "Format PSA ERCy&BI" tab's IF formulas, with the breakpoints from the workbook's
 * "ERC BREAK POINTS" and "BI BREAK POINTS" tabs (kept in data/erc_bi_breakpoints.csv, edited by hand):
 *   ERCy: ≥97th → 97, ≥90th → 90, ≥85th → 85, ≥75th → 75, ≥50th → 50, otherwise 45
 *   BI:   ≥97th → 97, ≥90th → 90, >75th → 75, =75th → 50, ≥50th → 50, otherwise 45
 *
 * Works in the browser (window.PL_NFDRS) and in Node (require).
 */
(function (root) {
  "use strict";

  // 40 stations, as listed on the "Calc PSA Average ERCy&BI" tab. Eight Mile Draw counts in SW-13 and SW-14N.
  const STATIONS = {
    "SW-01": [[20207, "Tusayan"], [20212, "Dry Park"], [20213, "Frazier Wells"]],
    "SW-02": [[20115, "Moss Basin"], [20501, "Iron Springs"], [20509, "Stanton"]],
    "SW-03": [[45801, "Senator Wash"]],
    "SW-04": [[20402, "Piney Hill"], [290101, "Washington Pass"], [290102, "Albino"]],
    "SW-05": [[20209, "Flagstaff"], [20301, "Heber"], [20303, "Lakeside"]],
    "SW-06N": [[20601, "Globe"], [20606, "Tonto Basin"]],
    "SW-06S": [[21005, "Columbine"], [21007, "Muleshoe"], [21202, "Saguaro"], [21206, "Sasabe"]],
    "SW-07": [[290702, "Jemez"], [290801, "Tower"], [291302, "Grants"]],
    "SW-08": [[20401, "Alpine"], [292001, "Beaverhead"], [292008, "Slaughter"], [292009, "Pelona"]],
    "SW-09": [[292103, "Bosque"], [292702, "Hachita Valley/Hatchett"], [292903, "Dripping Springs"]],
    "SW-10": [[290210, "Truchas"], [291202, "Pecos"]],
    "SW-11": [[291501, "Mountainair"], [292102, "Chupadera"]],
    "SW-12": [[292203, "Smokey Bear"], [293002, "Mayhill"], [293003, "Mescal"]],
    "SW-13": [[418701, "Cedar"], [292301, "Eight Mile"]],
    "SW-14N": [[292301, "Eight Mile"], [293101, "Batdraw"], [293104, "Caprock"]],
  };

  // Breakpoints: the workbook's "ERC BREAK POINTS" (ERCs 8/25) and "BI BREAK POINTS" (BI -8/25) tabs, copied exactly.
  // These are only the starting values: the site and the job use data/erc_bi_breakpoints.csv, which is
  // edited by hand when the breakpoints are recalculated (or replaced by uploading the NFDRSy workbook).
  const DEFAULT_BREAKPOINTS = {
    "SW-01": { erc: { p10: 11.8, p20: 18.7, p30: 24.5, p40: 29.6, p50: 34.3, p60: 39.1, p70: 43.9, p75: 46.1, p80: 49.1, p85: 52.4, p90: 56.9, p95: 61.9, p97: 63.5 }, bi: { p10: 5.06, p20: 12.8, p30: 16.4, p40: 19.9, p50: 22.7, p60: 25.2, p70: 27.8, p75: 29, p80: 30.6, p85: 32.4, p90: 34.7, p95: 37.5, p97: 39.4 } },
    "SW-02": { erc: { p10: 25.9, p20: 32.8, p30: 37.9, p40: 42.4, p50: 47, p60: 50.5, p70: 53.9, p75: 56.1, p80: 58.4, p85: 61.1, p90: 65.4, p95: 68.7, p97: 70.1 }, bi: { p10: 20.5, p20: 25.1, p30: 28.2, p40: 30.8, p50: 33.3, p60: 35.6, p70: 38.3, p75: 39.7, p80: 41.3, p85: 42.9, p90: 44.8, p95: 47.5, p97: 49.5 } },
    "SW-03": { erc: { p10: 34.6, p20: 41.6, p30: 47.3, p40: 52.3, p50: 55.7, p60: 58.9, p70: 62.1, p75: 64, p80: 66.1, p85: 68.4, p90: 71.3, p95: 74.6, p97: 75.9 }, bi: { p10: 24.7, p20: 29.1, p30: 32.4, p40: 35.1, p50: 37.8, p60: 40.1, p70: 42.4, p75: 43.9, p80: 45.1, p85: 46.7, p90: 48.6, p95: 51.6, p97: 53.7 } },
    "SW-04": { erc: { p10: 5.3, p20: 13.3, p30: 21, p40: 28.3, p50: 33.3, p60: 38.7, p70: 43.3, p75: 45.5, p80: 47.7, p85: 50.7, p90: 54.9, p95: 60.9, p97: 63.4 }, bi: { p10: 0, p20: 6.72, p30: 14, p40: 18.7, p50: 21.8, p60: 24.3, p70: 26.8, p75: 28, p80: 29.4, p85: 31, p90: 33.5, p95: 36.5, p97: 37.9 } },
    "SW-05": { erc: { p10: 13.7, p20: 20.5, p30: 25.7, p40: 29.7, p50: 33.4, p60: 37.2, p70: 41.2, p75: 43.5, p80: 46.4, p85: 49.4, p90: 52.4, p95: 58.2, p97: 61 }, bi: { p10: 7.21, p20: 15.2, p30: 19.1, p40: 21.7, p50: 23.6, p60: 25.5, p70: 27.7, p75: 29.3, p80: 30.9, p85: 32.8, p90: 35.1, p95: 38.1, p97: 39.8 } },
    "SW-06N": { erc: { p10: 26.3, p20: 33.4, p30: 39.5, p40: 45.2, p50: 49.3, p60: 53.4, p70: 57.9, p75: 60.4, p80: 63.2, p85: 66.4, p90: 71, p95: 75, p97: 77 }, bi: { p10: 20.3, p20: 24.3, p30: 27.5, p40: 30.5, p50: 33.5, p60: 36.9, p70: 40.8, p75: 42.7, p80: 44.7, p85: 47, p90: 50.2, p95: 53.3, p97: 55.5 } },
    "SW-06S": { erc: { p10: 23, p20: 27.6, p30: 32, p40: 36.2, p50: 41, p60: 45.6, p70: 50.2, p75: 52.8, p80: 55.4, p85: 58.3, p90: 62.3, p95: 67, p97: 69.1 }, bi: { p10: 17.3, p20: 20.4, p30: 23.2, p40: 25.7, p50: 28, p60: 30.6, p70: 33.8, p75: 35.4, p80: 37.2, p85: 39.3, p90: 41.4, p95: 44.5, p97: 46.3 } },
    "SW-07": { erc: { p10: 10, p20: 18.7, p30: 26, p40: 30.6, p50: 34.4, p60: 38.2, p70: 42.2, p75: 44.1, p80: 46.2, p85: 48.8, p90: 52.6, p95: 58, p97: 60.1 }, bi: { p10: 5.28, p20: 11.7, p30: 17.9, p40: 21.3, p50: 23.5, p60: 25.7, p70: 28, p75: 29.3, p80: 30.8, p85: 32.6, p90: 35, p95: 38, p97: 39.7 } },
    "SW-08": { erc: { p10: 17.7, p20: 24.4, p30: 28.4, p40: 32.1, p50: 35.9, p60: 40.2, p70: 43.9, p75: 45.7, p80: 48.4, p85: 51.1, p90: 54.3, p95: 59.5, p97: 61.9 }, bi: { p10: 10.6, p20: 16.8, p30: 19.7, p40: 22.1, p50: 24.2, p60: 26.4, p70: 28.8, p75: 30.3, p80: 32.1, p85: 34.1, p90: 36.5, p95: 39.5, p97: 41.1 } },
    "SW-09": { erc: { p10: 30.8, p20: 35.3, p30: 38.5, p40: 41.8, p50: 45, p60: 48.8, p70: 52.9, p75: 55.4, p80: 57.8, p85: 60.1, p90: 63.3, p95: 67.2, p97: 70.1 }, bi: { p10: 22.6, p20: 25.6, p30: 28, p40: 30.5, p50: 33, p60: 35.9, p70: 39.2, p75: 41.1, p80: 42.9, p85: 45, p90: 47.5, p95: 51.1, p97: 53.8 } },
    "SW-10": { erc: { p10: 9.6, p20: 15.3, p30: 22.7, p40: 27.4, p50: 31, p60: 34.2, p70: 37.4, p75: 39.1, p80: 41, p85: 43.4, p90: 46.4, p95: 49.6, p97: 52.2 }, bi: { p10: 0, p20: 10.8, p30: 16, p40: 20.1, p50: 22.2, p60: 24, p70: 26.1, p75: 27.1, p80: 28.2, p85: 29.6, p90: 31.4, p95: 34.6, p97: 36.4 } },
    "SW-11": { erc: { p10: 25.9, p20: 30.7, p30: 33.8, p40: 36.9, p50: 40.4, p60: 43.4, p70: 46.9, p75: 48.7, p80: 51, p85: 53.5, p90: 56.5, p95: 60.1, p97: 62.1 }, bi: { p10: 20.6, p20: 24.9, p30: 27.5, p40: 29.8, p50: 32.2, p60: 34.5, p70: 37, p75: 38.7, p80: 40.6, p85: 42.5, p90: 45.3, p95: 49.2, p97: 51.5 } },
    "SW-12": { erc: { p10: 22.8, p20: 27, p30: 30.2, p40: 33, p50: 35.7, p60: 38.9, p70: 42.5, p75: 44.2, p80: 46.2, p85: 48.4, p90: 51.3, p95: 54.7, p97: 57.4 }, bi: { p10: 16.5, p20: 20.3, p30: 22.5, p40: 24.5, p50: 26.8, p60: 29.2, p70: 31.7, p75: 33.3, p80: 34.8, p85: 36.7, p90: 39.5, p95: 43.7, p97: 46.4 } },
    "SW-13": { erc: { p10: 25.4, p20: 29.5, p30: 32.6, p40: 35.4, p50: 38.1, p60: 41, p70: 43.8, p75: 45.2, p80: 46.8, p85: 48.7, p90: 50.9, p95: 54, p97: 56.2 }, bi: { p10: 20.1, p20: 24, p30: 26.6, p40: 28.8, p50: 30.9, p60: 33.1, p70: 35.6, p75: 37.1, p80: 38.6, p85: 40.3, p90: 42.8, p95: 46.3, p97: 48.8 } },
    "SW-14N": { erc: { p10: 27.1, p20: 32.1, p30: 35.7, p40: 39.1, p50: 42.5, p60: 45.5, p70: 48.5, p75: 50, p80: 51.5, p85: 53.4, p90: 56, p95: 60, p97: 62.2 }, bi: { p10: 23.2, p20: 27.3, p30: 30.3, p40: 32.9, p50: 35.6, p60: 38.1, p70: 40.8, p75: 42.4, p80: 44.2, p85: 46.3, p90: 49.3, p95: 52.9, p97: 55.6 } },
  };
  let BREAKPOINTS = DEFAULT_BREAKPOINTS, BREAKPOINTS_SOURCE = "ERC BREAK POINTS / BI BREAK POINTS tabs (8/25), built in";
  const PCOLS = ["p10", "p20", "p30", "p40", "p50", "p60", "p70", "p75", "p80", "p85", "p90", "p95", "p97"];

  /* data/erc_bi_breakpoints.csv: psa,index(ERC|BI),p10,…,p97[,note] → { "SW-01": { erc: {…}, bi: {…} } } */
  function readBreakpointsCsv(text) {
    const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l)).map(splitCsv);
    const H = lines[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const ci = (n) => H.indexOf(n);
    if (ci("psa") < 0 || ci("index") < 0 || ci("p50") < 0) throw new Error("breakpoints file needs columns psa, index, p10 … p97");
    const out = {};
    for (const r of lines.slice(1)) {
      const psa = psaKey(r[ci("psa")]), idx = String(r[ci("index")] || "").trim().toLowerCase();
      if (!psa || !["erc", "bi"].includes(idx)) continue;
      const row = {};
      for (const c of PCOLS) { const i = ci(c); const v = i >= 0 ? parseFloat(r[i]) : NaN; if (Number.isFinite(v)) row[c] = v; }
      (out[psa] = out[psa] || {})[idx] = row;
    }
    return checkBreakpoints(out);
  }
  /* The workbook's "ERC BREAK POINTS" / "BI BREAK POINTS" tabs (rows of cells, header row first). */
  function readBreakpointTabs(ercRows, biRows) {
    const out = {};
    for (const [rows, idx] of [[ercRows, "erc"], [biRows, "bi"]]) {
      const H = (rows[0] || []).map((h) => { const m = String(h ?? "").match(/(\d+)\s*th/i); return m ? `p${m[1]}` : ""; });
      for (const r of rows.slice(1)) {
        const psa = psaKey(r && r[0]); if (!psa) continue;
        const row = {};
        H.forEach((c, i) => { if (PCOLS.includes(c)) { const v = parseFloat(r[i]); if (Number.isFinite(v)) row[c] = v; } });
        (out[psa] = out[psa] || {})[idx] = row;
      }
    }
    return checkBreakpoints(out);
  }
  function checkBreakpoints(t) {
    const need = { erc: ["p50", "p75", "p85", "p90", "p97"], bi: ["p50", "p75", "p90", "p97"] };
    const bad = [];
    for (const psa of Object.keys(STATIONS)) for (const [idx, ks] of Object.entries(need)) {
      const r = (t[psa] || {})[idx];
      if (!r) { bad.push(`${psa} ${idx.toUpperCase()} missing`); continue; }
      for (const k of ks) if (!Number.isFinite(r[k])) bad.push(`${psa} ${idx.toUpperCase()} ${k.slice(1)}th missing`);
      const v = ks.map((k) => r[k]);
      if (v.every(Number.isFinite) && v.some((x, i) => i && x < v[i - 1])) bad.push(`${psa} ${idx.toUpperCase()} percentiles out of order (${ks.map((k, i) => `${k.slice(1)}th ${v[i]}`).join(", ")})`);
    }
    if (bad.some((b) => /missing/.test(b))) throw new Error(`Breakpoints incomplete: ${bad.filter((b) => /missing/.test(b)).slice(0, 6).join("; ")}`);
    t.warnings = bad;
    return t;
  }
  /* Back to the CSV layout of data/erc_bi_breakpoints.csv. */
  function breakpointsCsv(t, note = "") {
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [["psa", "index", ...PCOLS, "note"].join(",")];
    for (const idx of ["erc", "bi"]) for (const psa of Object.keys(STATIONS)) {
      const r = (t[psa] || {})[idx] || {};
      lines.push([psa, idx.toUpperCase(), ...PCOLS.map((c) => (Number.isFinite(r[c]) ? r[c] : "")), q(note)].join(","));
    }
    return lines.join("\n") + "\n";
  }
  function setBreakpoints(t, source) { BREAKPOINTS = t; BREAKPOINTS_SOURCE = source || "data/erc_bi_breakpoints.csv"; return t.warnings || []; }
  function psaKey(v) {
    const m = String(v ?? "").toUpperCase().replace(/\s+/g, "").match(/^(?:SW|PSA)-?0*(\d{1,2})([NS]?)/);
    if (!m) return "";
    const k = `SW-${m[1].padStart(2, "0")}${m[2]}`;
    return STATIONS[k] ? k : STATIONS[k + "N"] ? k + "N" : "";
  }

  const ALL_IDS = [...new Set(Object.values(STATIONS).flat().map(([id]) => id))];
  const URL_BASE = "https://fems.fs2c.usda.gov/api/climatology/download-nfdr-daily-summary/";
  function downloadUrl(date, endDate = date, ids = ALL_IDS, fuelModel = "Y", dataset = "observation") {
    return `${URL_BASE}?dataset=${dataset}&startDate=${date}&endDate=${endDate}&dataFormat=csv&stationIds=${ids.join(",")}&fuelModels=${fuelModel}`;
  }

  const r1 = (x) => Math.round(x * 10 + 1e-9 * Math.sign(x)) / 10; // one decimal
  // Excel ROUNDUP(x, 0) for the positive sums used here (guards against 15.000000000002-style float noise).
  const roundUp = (x) => Math.ceil(Math.round(x * 1e9) / 1e9);

  function ercPercentile(v, b) {
    if (v >= b.p97) return 97;
    if (v >= b.p90) return 90;
    if (v >= b.p85) return 85;
    if (v >= b.p75) return 75;
    if (v >= b.p50) return 50;
    return 45;
  }
  function biPercentile(v, b) {
    if (v >= b.p97) return 97;
    if (v >= b.p90) return 90;
    if (v > b.p75) return 75;
    if (v === b.p75) return 50; // as the workbook formula has it
    if (v >= b.p50) return 50;
    return 45;
  }

  /* ---------- reading the FEMS daily summary CSV ---------- */
  const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const NAME_ALIASES = { MULESHOERANCH: 21007, ALBINOCANYON: 290102, PELONAMOUNTAIN: 292009, PELONAMTN: 292009, HACHITAVALLEY: 292702, HATCHETT: 292702,
    EIGHTMILEDRAW: 292301, EIGHTMILE: 292301, SLAUGHTERMESA: 292008, FRAZIERWELL: 20213, DRYPARK: 20212, BATDRAW: 293101 };
  const BY_NAME = Object.assign({}, ...Object.values(STATIONS).flat().map(([id, n]) => ({ [norm(n)]: id })), NAME_ALIASES);
  function splitCsv(line) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  function isoDate(v) {
    if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10); // Excel serial date
    const s = String(v ?? "").trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    return "";
  }
  /* rows: arrays of cells, first row the header (as in the CSV or the workbook's IMPORT RAW WEB DATA tab).
     Returns { date, stations: { id: { id, name, erc, bi, date } }, unknown: [names] }. */
  function readSummary(rows, opts = {}) {
    const hi = rows.findIndex((r) => r && r.some((c) => norm(c) === "ERC") && r.some((c) => norm(c) === "BI"));
    if (hi < 0) throw new Error("This doesn't look like a FEMS NFDR daily summary: no ERC and BI columns.");
    const H = rows[hi].map(norm), col = (...names) => names.map((n) => H.indexOf(n)).find((i) => i >= 0) ?? -1;
    const cName = col("STATIONNAME", "STATION", "NAME"), cTime = col("OBSERVATIONTIME", "NFDRDATE", "DATE", "OBSDATE"), cErc = col("ERC"), cBi = col("BI");
    const cType = col("NFDRTYPE", "TYPE"), cFm = col("FUELMODEL");
    let cId = col("STATIONID", "STATIONID1", "STNID", "STATION_ID");
    const body = rows.slice(hi + 1).filter((r) => r && r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
    if (cId < 0) { // the download puts the station ID in an unlabelled column; find the column whose values are our station IDs
      const ids = new Set(ALL_IDS.map(String));
      let best = -1, bestN = 0;
      for (let c = 0; c < Math.max(...body.map((r) => r.length)); c++) { const n = body.filter((r) => ids.has(String(r[c] ?? "").trim().replace(/\.0$/, ""))).length; if (n > bestN) { best = c; bestN = n; } }
      if (bestN >= Math.min(3, body.length)) cId = best;
    }
    const stations = {}, unknown = [], dates = {};
    for (const r of body) {
      if (!opts.anyType && cType >= 0 && r[cType] && String(r[cType]).trim().toUpperCase() !== "O") continue; // observed only, unless reading the forecast
      if (cFm >= 0 && r[cFm] && !/Y/i.test(String(r[cFm]))) continue;
      let id = cId >= 0 ? parseInt(String(r[cId]).trim(), 10) : NaN;
      if (!ALL_IDS.includes(id)) id = BY_NAME[norm(r[cName])];
      if (!id) { if (r[cName]) unknown.push(String(r[cName])); continue; }
      const erc = parseFloat(r[cErc]), bi = parseFloat(r[cBi]);
      const date = r[cTime] instanceof Date ? r[cTime].toISOString().slice(0, 10) : isoDate(r[cTime]);
      if (date) dates[date] = (dates[date] || 0) + 1;
      const prev = stations[id];
      // several days in one file: keep the latest day per station
      if (!prev || (date && date > prev.date)) stations[id] = { id, name: String(r[cName] ?? "").trim(), erc: Number.isFinite(erc) ? r1(erc) : null, bi: Number.isFinite(bi) ? r1(bi) : null, date };
    }
    const date = Object.keys(dates).sort().pop() || "";
    for (const id of Object.keys(stations)) if (date && stations[id].date && stations[id].date !== date) delete stations[id];
    return { date, stations, unknown };
  }
  /* Several days in one download (a date range): { "2026-01-01": { id: {…} }, … }. */
  function readSummaryByDate(rows, opts = {}) {
    const hi = rows.findIndex((r) => r && r.some((c) => norm(c) === "ERC") && r.some((c) => norm(c) === "BI"));
    if (hi < 0) throw new Error("This doesn't look like a FEMS NFDR daily summary: no ERC and BI columns.");
    const H = rows[hi].map(norm);
    const cTime = ["OBSERVATIONTIME", "NFDRDATE", "DATE", "OBSDATE"].map((n) => H.indexOf(n)).find((i) => i >= 0) ?? -1;
    const by = {};
    for (const r of rows.slice(hi + 1)) {
      if (!r || !r.some((c) => c !== null && c !== undefined && String(c).trim() !== "")) continue;
      const d = r[cTime] instanceof Date ? r[cTime].toISOString().slice(0, 10) : isoDate(r[cTime]);
      if (d) (by[d] = by[d] || []).push(r);
    }
    const out = {};
    for (const [d, list] of Object.entries(by)) out[d] = readSummary([rows[hi], ...list], opts).stations;
    return out;
  }
  const csvRows = (text) => String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).map(splitCsv);
  function readCsv(text) { return readSummary(String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim()).map(splitCsv)); }

  /* ---------- the PSA calculation ---------- */
  function psaValues(stations, date) {
    const rows = {}, list = [];
    const BP = BREAKPOINTS;
    for (const [psa, members] of Object.entries(STATIONS)) {
      const got = members.filter(([id]) => stations[id] && stations[id].erc !== null);
      const missing = members.filter(([id]) => !(stations[id] && stations[id].erc !== null)).map(([, n]) => n);
      for (const [id, name] of members) { const s = stations[id]; list.push({ psa, id, name, erc: s && s.erc !== null ? r1(s.erc) : null, bi: s && s.bi !== null ? r1(s.bi) : null, reported: Boolean(s && s.erc !== null) }); }
      if (!got.length) { rows[psa] = { ercVal: "", biVal: "", ercPct: "", biPct: "", stations: 0, stationsListed: members.length, missing }; continue; }
      const n = got.length;
      const ercVal = r1(roundUp(got.reduce((a, [id]) => a + r1(stations[id].erc), 0)) / n);
      const biVals = got.map(([id]) => stations[id].bi).filter((v) => v !== null).map(r1);
      const biVal = biVals.length ? r1(biVals.reduce((a, b) => a + b, 0) / biVals.length) : null;
      const b = BP[psa];
      rows[psa] = { ercVal, biVal: biVal === null ? "" : biVal,
        ercPct: ercPercentile(ercVal, b.erc), biPct: biVal === null ? "" : biPercentile(biVal, b.bi), stations: n, stationsListed: members.length, missing };
    }
    return { date, rows, stations: list, breakpoints: BREAKPOINTS_SOURCE };
  }

  const api = { STATIONS, DEFAULT_BREAKPOINTS, ALL_IDS, downloadUrl, readSummary, readSummaryByDate, readCsv, csvRows, psaValues, ercPercentile, biPercentile, roundUp,
    readBreakpointsCsv, readBreakpointTabs, breakpointsCsv, setBreakpoints, psaKey, get BREAKPOINTS() { return BREAKPOINTS; }, get BREAKPOINTS_SOURCE() { return BREAKPOINTS_SOURCE; } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PL_NFDRS = api;
})(typeof window !== "undefined" ? window : globalThis);
