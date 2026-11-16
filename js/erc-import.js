/*
 * ERC / BI file import. Reads an uploaded .xlsx or .csv and returns ERCy and BI values and percentiles
 * for each PSA. Shared by the page (PSA ERCy tab → Upload) and scripts/update-data.mjs (uploads/ folder).
 *
 * Accepted layouts:
 *  • One row per PSA with headers such as  PSA | ERCy Avg | BI Avg | ERCy Percentile | BI Percentile | ObsDate
 *    (the NFDRSy_Ingest layout); column order and extra columns don't matter.
 *  • Several rows per PSA (stations, or several days): values are averaged per PSA, using only each
 *    PSA's latest date when a date column is present.
 *  • No header row: PSA, ERCy, BI, ERCy percentile, BI percentile, date, in that order.
 */
(function (root) {
  "use strict";

  function makeImport(C, X) {
    const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
    const num = (v) => { if (typeof v === "number") return Number.isFinite(v) ? v : null; const n = parseFloat(clean(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };

    // "SW-01", "SW01", "sw 1", "SW06N", "SW-14N NE NM" → the PSA's ercId ("SW-01" …)
    const byKey = Object.fromEntries(C.psas.map((p) => [p.id.toUpperCase(), p.ercId]));
    function psaOf(v) {
      const m = clean(v).toUpperCase().match(/SW\s*-?\s*(\d{1,2})\s*([NS])?(?![0-9])/);
      if (!m) return null;
      return byKey[`SW${m[1].padStart(2, "0")}${m[2] || ""}`] || null;
    }
    function isoDate(v) {
      if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
      const s = clean(v);
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
      m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      return "";
    }

    function parseCsv(text) {
      const rows = [];
      const delim = (text.split(/\r?\n/).find((l) => l.trim()) || "").includes("\t") ? "\t" : ",";
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) { rows.push([]); continue; }
        const cells = []; let cur = "", q = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
          else if (ch === '"') q = true;
          else if (ch === delim) { cells.push(cur); cur = ""; }
          else cur += ch;
        }
        cells.push(cur);
        rows.push(cells.map((c) => c.trim()));
      }
      return rows;
    }

    /* Finds the header row and which column holds what. */
    function findColumns(rows) {
      for (let r = 0; r < Math.min(rows.length, 30); r++) {
        const h = (rows[r] || []).map((c) => clean(c).toLowerCase());
        const isPct = (c) => /perc|pct|%|pctl|percentile/.test(c);
        const isErc = (c) => /\berc|energy release/.test(c);
        const isBi = (c) => /\bbi\b|\bbi[\s_-]|^bi|burning index/.test(c) && !/bin/.test(c);
        const find = (fn) => h.findIndex(fn);
        const map = {
          psa: find((c) => /\bpsa\b|^psa|predictive service/.test(c)),
          ercVal: find((c) => isErc(c) && !isPct(c)),
          ercPct: find((c) => isErc(c) && isPct(c)),
          biVal: find((c) => isBi(c) && !isPct(c)),
          biPct: find((c) => isBi(c) && isPct(c)),
          date: find((c) => /date|obs|day/.test(c) && !isErc(c) && !isBi(c)),
        };
        if (map.psa < 0 && h.some(isErc)) map.psa = 0; // header row present but PSA column unnamed
        if (map.psa >= 0 && [map.ercVal, map.ercPct, map.biVal, map.biPct].some((i) => i >= 0)) return { row: r, map };
      }
      return null;
    }

    function parseRows(rows) {
      let cols = findColumns(rows);
      let start;
      if (cols) start = cols.row + 1;
      else { cols = { map: { psa: 0, ercVal: 1, biVal: 2, ercPct: 3, biPct: 4, date: 5 } }; start = 0; } // NFDRSy_Ingest order
      const m = cols.map;
      const records = [];
      const unmatched = new Set();
      for (const row of rows.slice(start)) {
        if (!row || !row.length) continue;
        const id = psaOf(row[m.psa]);
        if (!id) { const t = clean(row[m.psa]); if (/^sw/i.test(t)) unmatched.add(t); continue; }
        const rec = { id, date: m.date >= 0 ? isoDate(row[m.date]) : "" };
        for (const k of ["ercVal", "ercPct", "biVal", "biPct"]) rec[k] = m[k] >= 0 ? num(row[m[k]]) : null;
        if (["ercVal", "ercPct", "biVal", "biPct"].every((k) => rec[k] === null)) continue;
        records.push(rec);
      }
      if (!records.length) throw new Error("No PSA rows with ERC or BI values were found. The file needs a PSA column (SW01 … SW14N) and ERC and/or BI columns.");

      // latest date per PSA, then average
      const out = {};
      let fileDate = "";
      for (const p of C.psas) {
        let recs = records.filter((r) => r.id === p.ercId);
        if (!recs.length) continue;
        const latest = recs.reduce((a, r) => (r.date > a ? r.date : a), "");
        if (latest) recs = recs.filter((r) => r.date === latest);
        if (latest > fileDate) fileDate = latest;
        const avg = (k) => { const v = recs.map((r) => r[k]).filter((x) => x !== null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : ""; };
        out[p.ercId] = { ercVal: avg("ercVal"), biVal: avg("biVal"), ercPct: avg("ercPct"), biPct: avg("biPct"), rowsUsed: recs.length, date: latest };
      }
      const columns = Object.entries(m).filter(([, i]) => i >= 0).map(([k]) => k);
      return { rows: out, date: fileDate, columns, rowsRead: records.length, missing: C.psas.filter((p) => !out[p.ercId]).map((p) => p.ercId), unmatched: [...unmatched] };
    }

    /* bytes: Uint8Array/ArrayBuffer of the file; name: file name (for the type). */
    async function importFile(bytes, name) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const isZip = u8[0] === 0x50 && u8[1] === 0x4b;
      if (isZip) {
        const sheets = await X.readXlsx(u8);
        const errors = [];
        for (const [sheetName, get] of Object.entries(sheets)) {
          try { return { ...parseRows(get()), sheet: sheetName }; }
          catch (e) { errors.push(`${sheetName}: ${e.message}`); }
        }
        throw new Error(errors[0] ? errors[0].replace(/^[^:]+: /, "") : "The workbook has no sheets.");
      }
      if (/\.xls$/i.test(name || "") || (u8[0] === 0xd0 && u8[1] === 0xcf)) throw new Error("Old .xls files can't be read. In Excel use File → Save As → Excel Workbook (.xlsx) or CSV, then upload that.");
      return parseRows(parseCsv(new TextDecoder("utf-8").decode(u8)));
    }

    return { importFile, parseRows, parseCsv, psaOf };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeImport;
  else root.PL_ERC_IMPORT = makeImport(root.PL_CONFIG, root.PL_XLSX_READ);
})(typeof window !== "undefined" ? window : globalThis);
