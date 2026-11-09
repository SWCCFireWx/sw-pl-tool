// Reads crews and IMTs from the SWCC SharePoint workbooks.
// Columns are found by their header text (as in the SWA/OOA Type 1 IHC and Incident Management Teams tabs),
// so extra title rows, added columns or reordered columns don't break it.
"use strict";
const { readXlsx, excelDate } = require("../../js/xlsx-read.js");

const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

// field → header names that identify it (after norm()). First match wins, exact before prefix.
const CREW_COLS = {
  name: ["SWACREW", "OOACREW", "CREW", "CREWNAME"],
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
    const cells = (rows[r] || []).map(norm);
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

function sheetByName(sheets, wanted) {
  const want = norm(wanted);
  const name = Object.keys(sheets).find((n) => norm(n) === want) || Object.keys(sheets).find((n) => norm(n).includes(want));
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
    remarks: [r.remarks, r.incDisp && `Dispatch ${r.incDisp}`].filter(Boolean).join(" · ") };
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
  } catch (e) { if (!/header row/.test(e.message)) throw e; } // an empty OOA tab is normal
  return { crews, ooaCrews: ooa.filter((c) => c.name), lastUpdate: lastUpdate(swaRows), ooaLastUpdate: ooaUpdate };
}
async function parseImtWorkbook(buf, sheetName) {
  const sheets = await readXlsx(buf);
  const rows = sheetByName(sheets, sheetName);
  const imts = readTable(rows, IMT_COLS, ["ic", "status"], sheetName).map(toImt).filter((t) => t.ic || t.zone);
  return { imts, lastUpdate: lastUpdate(rows) };
}

// Turns an "anyone with the link" SharePoint sharing URL into a direct download.
function downloadUrl(shareUrl) {
  const u = new URL(shareUrl);
  for (const k of [...u.searchParams.keys()]) u.searchParams.delete(k);
  u.searchParams.set("download", "1");
  return u.toString();
}
async function fetchWorkbook(shareUrl, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(downloadUrl(shareUrl), { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (SWA PL tool)" } });
  if (!r.ok) throw new Error(`SharePoint answered ${r.status} for ${new URL(shareUrl).pathname.split("/").pop()}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    const text = buf.toString("utf8", 0, 400);
    throw new Error(/sign in|login|microsoftonline/i.test(text)
      ? "SharePoint returned a sign-in page. Check that the link is shared with “Anyone with the link”."
      : "SharePoint did not return an Excel file.");
  }
  return buf;
}

module.exports = { lastUpdate, parseCrewWorkbook, parseImtWorkbook, fetchWorkbook, downloadUrl, readTable, CREW_COLS, IMT_COLS };
