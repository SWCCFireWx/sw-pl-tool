// Reads crews and IMTs from the SWCC SharePoint workbooks.
// Columns are found by their header text (as in the SWA/OOA Type 1 IHC and Incident Management Teams tabs),
// so extra title rows, added columns or reordered columns don't break it.
"use strict";
const XR = require("../../js/xlsx-read.js");
const { excelDate } = XR;
const readXlsx = (buf) => XR.readXlsx(buf);

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

// field → header names that identify it (after norm()). First match wins, exact before prefix.
const CREW_COLS = {
  name: ["SWACREW", "OOACREW", "SWAT2IACREW", "T2IACREW", "TYPE2IACREW", "2IACREW", "CREW", "CREWNAME"],
  type: ["CURRENTTYPE", "TYPE"],
  state: ["HOMESTATE"],
  disp: ["HOMEDISP", "HOMEDISPATCH"],
  unit: ["HOMEUNIT"],
  dayOff: ["DAYOFF", "DAYSOFF"],
  status: ["STATUS"],
  dateCom: ["DATECOM", "DATECOMTOSWA", "DATECOMM"],
  daysLeft: ["DAYSLEFT"],
  incState: ["INCIDENTSTATE"],
  incUnit: ["INCIDENTUNIT"],
  incDisp: ["INCIDENTDISPGACC", "INCIDENTDISP"],
  incident: ["INCIDENTNAME"],
  lastDay: ["LASTDAY"],
  host: ["HOSTSWADISPATCH", "HOSTDISPATCH"],
  location: ["LOCATION"],
  remarks: ["REMARKS", "COMMENTS"],
};
const IMT_COLS = {
  mob: ["MOBLOCATION", "MOB"],
  type: ["TYPE"],
  zone: ["NBRZONE", "NOZONE", "ZONE", "NBR"],
  ic: ["INCIDENTCOMMANDER", "IC"],
  home: ["HOMEDISPATCH", "HOME"],
  status: ["STATUS"],
  dateComm: ["DATECOMM", "DATECOM"],
  incState: ["STATE"],
  incUnit: ["UNIT"],
  incDisp: ["DISPATCHGACC"],
  incident: ["INCIDENT", "INCIDENTNAME"],
  remarks: ["REMARKS"],
  releaseDate: ["RELEASEDATE"],
  availableDate: ["AVAILABLEDATE"],
};
const DATE_FIELDS = new Set(["dateCom", "lastDay", "dateComm", "releaseDate", "availableDate"]);

function findHeader(rows, cols, required) {
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cells = Array.from(rows[r] || [], norm); // Array.from fills empty cells (holes) with ""
    const map = {};
    for (const [field, names] of Object.entries(cols)) {
      let idx = -1;
      for (const n of names) { idx = cells.findIndex((c) => c === n); if (idx >= 0) break; }
      if (idx < 0) for (const n of names) { if (n.length < 4) continue; idx = cells.findIndex((c) => c.startsWith(n)); if (idx >= 0) break; }
      if (idx >= 0 && !Object.values(map).includes(idx)) map[field] = idx;
    }
    if (required.every((f) => f in map) && Object.keys(map).length >= 4) return { row: r, map };
  }
  return null;
}

function readTable(rows, cols, required, label) {
  const h = findHeader(rows, cols, required);
  if (!h) throw new Error(`Couldn't find the header row on "${label}" (looked for columns like ${required.map((f) => cols[f][0]).join(", ")}).`);
  const out = [];
  let blanks = 0;
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const first = clean(row[h.map[required[0]]]);
    if (!first || /^[-*_=.\s]+$/.test(first)) { if (++blanks >= 8) break; continue; } // blank, ---- or **** separator rows
    blanks = 0;
    if (/^(last update|updated|total|key|legend)/i.test(first)) continue;
    const rec = {};
    for (const [field, c] of Object.entries(h.map)) rec[field] = DATE_FIELDS.has(field) ? excelDate(row[c]) : clean(row[c]);
    out.push(rec);
  }
  return out;
}

// Text next to a "Last Update:" label anywhere on the tab, e.g. "11/3/26 7:00 AM" or "0700 11/09/2026 DH".
function lastUpdate(rows) {
  for (const row of rows) {
    const i = (row || []).findIndex((c) => /^\s*last\s*update/i.test(clean(c)));
    if (i < 0) continue;
    const inline = clean(row[i]).replace(/^last\s*update:?\s*/i, "");
    if (inline) return inline;
    for (let j = i + 1; j < row.length; j++) {
      const v = row[j];
      if (v === null || v === undefined || clean(v) === "") continue;
      if (typeof v === "number" && v > 20000 && v < 80000) { // Excel date-time serial
        const d = new Date(Math.round((v - 25569) * 864e5));
        return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      }
      return clean(v);
    }
  }
  return "";
}

function sheetByName(sheets, wanted, pattern) {
  const want = norm(wanted);
  const name = Object.keys(sheets).find((n) => norm(n) === want) || Object.keys(sheets).find((n) => norm(n).includes(want))
    || (pattern && Object.keys(sheets).find((n) => pattern.test(n)));
  if (!name) throw new Error(`Tab "${wanted}" not found. Tabs in the workbook: ${Object.keys(sheets).join(", ")}.`);
  return sheets[name]();
}

function toCrew(r) {
  const status = r.status.toUpperCase().replace(/\s+/g, "");
  // Prepositioned crews: the incident dispatch/GACC column says where (SWCC counts as available).
  const location = (r.incDisp || r.location || r.host || "").toUpperCase();
  const remarks = [r.remarks, r.lastDay && `Last day ${r.lastDay}`, r.host && `Host ${r.host}`].filter(Boolean).join(" · ");
  return { name: r.name, type: (r.type || "").toUpperCase(), state: r.state || "", disp: r.disp || "", unit: r.unit || "",
    dayOff: r.dayOff || "", status, location, incident: r.incident || "", dateCom: r.dateCom || "", remarks };
}
function toImt(r) {
  return { mob: r.mob || "", type: (r.type || "").toUpperCase().replace(/^TYPE\s*/, ""), zone: r.zone || "", ic: r.ic || "",
    home: r.home || "", status: r.status.toUpperCase().replace(/\s+/g, ""), incident: r.incident || "", dateComm: r.dateComm || "",
    incState: (r.incState || "").toUpperCase(), incDisp: (r.incDisp || "").toUpperCase(), // where the team is assigned
    remarks: r.remarks || "" };
}

async function parseCrewWorkbook(buf, sheetNames) {
  const sheets = await readXlsx(buf);
  const swaRows = sheetByName(sheets, sheetNames.swa);
  const crews = readTable(swaRows, CREW_COLS, ["name", "status"], sheetNames.swa).map(toCrew);
  let ooa = [], ooaUpdate = "";
  try {
    const ooaRows = sheetByName(sheets, sheetNames.ooa);
    ooaUpdate = lastUpdate(ooaRows);
    ooa = readTable(ooaRows, CREW_COLS, ["name", "status"], sheetNames.ooa).map(toCrew);
  } catch (e) { if (!/header row|not found/.test(e.message)) throw e; } // an empty or missing OOA tab is normal
  // SWA Type 2IA crews (optional tab): named in config, or any tab like "Type 2IA" / "T2IA" / "2IA Crews"
  let t2ia = [], t2iaUpdate = "", t2iaSheet = "";
  if (sheetNames.t2ia) {
    try {
      const pattern = /(type\s*2\s*-?\s*ia|t2\s*-?\s*ia|\b2\s*ia\b)/i;
      const name = Object.keys(sheets).find((n) => norm(n) === norm(sheetNames.t2ia)) || Object.keys(sheets).find((n) => pattern.test(n));
      if (name) {
        const rows = sheets[name]();
        t2iaSheet = name; t2iaUpdate = lastUpdate(rows);
        t2ia = readTable(rows, CREW_COLS, ["name", "status"], name).map(toCrew).filter((c) => c.name);
      }
    } catch (e) { if (!/header row/.test(e.message)) throw e; }
  }
  return { crews, ooaCrews: ooa.filter((c) => c.name), lastUpdate: lastUpdate(swaRows), ooaLastUpdate: ooaUpdate, t2iaCrews: t2ia, t2iaLastUpdate: t2iaUpdate, t2iaSheet, sheetNames: Object.keys(sheets) };
}
async function parseImtWorkbook(buf, sheetName) {
  const sheets = await readXlsx(buf);
  const rows = sheetByName(sheets, sheetName);
  const imts = readTable(rows, IMT_COLS, ["ic", "status"], sheetName).map(toImt).filter((t) => t.ic || t.zone);
  return { imts, lastUpdate: lastUpdate(rows) };
}

// Ways to download an "anyone with the link" SharePoint file, tried in order:
//  1. the site's download page with the sharing token:  /sites/<site>/_layouts/15/download.aspx?share=<token>
//  2. the sharing link itself with ?download=1
function downloadUrls(shareUrl) {
  const u = new URL(shareUrl);
  const m = u.pathname.match(/^\/:[a-z]:\/([sr])\/([^/]+)\/([^/?]+)/i); // /:x:/s/<site>/<token>
  const urls = [];
  if (m) urls.push(`${u.origin}/${m[1].toLowerCase() === "s" ? "sites" : "teams"}/${m[2]}/_layouts/15/download.aspx?share=${m[3]}`);
  const d = new URL(shareUrl);
  for (const k of [...d.searchParams.keys()]) d.searchParams.delete(k);
  d.searchParams.set("download", "1");
  urls.push(d.toString());
  return urls;
}
const downloadUrl = (shareUrl) => downloadUrls(shareUrl).slice(-1)[0];

/* Follows redirects by hand and keeps cookies between them: an anonymous SharePoint link sets an
   access cookie on its first redirect and only serves the file to a request that sends it back. */
async function getWithCookies(url, fetchImpl, trail) {
  const jar = new Map();
  for (let hop = 0; hop < 12; hop++) {
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SWA-PL-tool", Accept: "*/*" };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetchImpl(url, { redirect: "manual", headers });
    const set = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
    for (const c of set) { const m = String(c).match(/^\s*([^=;\s]+)=([^;]*)/); if (m) jar.set(m[1], m[2]); }
    trail.push(`${r.status} ${new URL(url).host}${new URL(url).pathname.slice(0, 60)}`);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    return { r, url };
  }
  throw new Error("too many redirects");
}

async function fetchWorkbook(shareUrl, fetchImpl = globalThis.fetch) {
  const tried = [];
  for (const url of downloadUrls(shareUrl)) {
    const trail = [];
    try {
      const { r, url: finalUrl } = await getWithCookies(url, fetchImpl, trail);
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.ok && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) return buf;
      const text = buf.toString("utf8", 0, 600).replace(/\s+/g, " ");
      const what = /sign in|login\.microsoftonline|<title>[^<]*sign/i.test(text) || /login\.microsoftonline/.test(finalUrl) ? "a sign-in page"
        : r.ok ? `${r.headers.get("content-type") || "something"} instead of an Excel file` : `HTTP ${r.status}`;
      tried.push(`${what} [${trail.join(" → ")}]`);
    } catch (e) { tried.push(`${e.message} [${trail.join(" → ")}]`); }
  }
  throw new Error(`SharePoint didn't hand over the workbook. Tried ${tried.length} ways: ${tried.join(" | ")}. If it's a sign-in page, the link isn't open to "Anyone with the link" for downloads.`);
}

module.exports = { lastUpdate, parseCrewWorkbook, parseImtWorkbook, fetchWorkbook, downloadUrl, downloadUrls, readTable, CREW_COLS, IMT_COLS };
