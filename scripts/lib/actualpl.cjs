// The Southwest Area PL actually in effect, for checking the forecast against.
//  1. NICC (https://www.nifc.gov/nicc): a "Geographic Area | Preparedness Level" table with a Southwest row,
//     and "Last Updated: Thursday, November 19, 2026 - 06:18".
//  2. SWCC (https://gacc.nifc.gov/swcc/): whatever sits under the Preparedness Level header, if it's text,
//     an image or frame whose name or alt text carries the number.
// When neither can be read, the run log says so and data/archive/actual_pl_debug.txt keeps what the
// pages looked like, so the reader can be adjusted.
"use strict";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const text = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();

function nicc(html) {
  const rows = [...String(html).matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => text(c[1])));
  let pl = null;
  for (const r of rows) {
    if (r.length >= 2 && /^southwest\b/i.test(r[0])) { const n = r.slice(1).find((c) => /^[1-5]$/.test(c)); if (n) { pl = +n; break; } }
  }
  if (pl === null) { // not a table: "Southwest 1" / "Southwest Area (PL 1)" in the text
    const m = text(html).match(/\bSouthwest(?:\s+Area)?\s*(?:\(\s*PL\s*([1-5])\s*\)|:?\s*([1-5])\b)/i);
    if (m) pl = +(m[1] || m[2]);
  }
  // the table is there but has no rows (NICC leaves it empty in the off season)
  const notListed = pl === null && /Geographic Area\s*\|?\s*Preparedness Level/i.test(rows.map((r) => r.join(" | ")).join("\n")) && !rows.some((r) => r.length >= 2 && /^(southwest|northwest|alaska|eastern|great basin|rocky)/i.test(r[0]));
  const u = text(html).match(/Last Updated:?\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:\s*-\s*(\d{1,2}:\d{2}))?/i);
  const asOf = u && MONTHS.includes(u[1].toLowerCase()) ? `${u[3]}-${String(MONTHS.indexOf(u[1].toLowerCase()) + 1).padStart(2, "0")}-${u[2].padStart(2, "0")}${u[4] ? `T${u[4].padStart(5, "0")}` : ""}` : "";
  return { pl, asOf, notListed };
}

function swcc(html) {
  const s = String(html);
  const i = s.search(/PreparednessLevel/i);
  if (i < 0) return { pl: null, segment: "" };
  const rest = s.slice(i);
  const j = rest.search(/Header_Notes|V_T1_Header_(?!Preparedness)/i);
  const seg = rest.slice(0, j > 0 ? j : 4000);
  const t = text(seg.replace(/^[^>]*>/, ""));
  let m = t.match(/(?:\bPL|Preparedness\s+Level)\s*:?\s*([1-5])\b/i) || t.match(/^\s*([1-5])\s*$/);
  if (m) return { pl: +m[1], segment: seg };
  for (const tag of seg.match(/<(?:img|iframe|embed|object)[^>]*>/gi) || []) {
    const src = (tag.match(/(?:src|data)="([^"]+)"/i) || [])[1] || "", alt = (tag.match(/alt="([^"]*)"/i) || [])[1] || "";
    if (/PreparednessLevel\.gif/i.test(src)) continue; // the header itself
    m = alt.match(/(?:PL|Level)\s*([1-5])\b/i) || src.match(/(?:PL|Level)[_\- ]?([1-5])(?!\d)/i);
    if (m) return { pl: +m[1], segment: seg };
  }
  return { pl: null, segment: seg };
}

function makeActualPl(fetchImpl = globalThis.fetch) {
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { "User-Agent": "Mozilla/5.0 SWA-PL-tool (SWCC predictive services)", Accept: "text/html,*/*" } });
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r.text();
  };
  /* → { pl, asOf, source, tried: [...], debug } */
  async function fetchActual() {
    const tried = [], debug = [];
    let notListed = false;
    try {
      const h = await get("https://www.nifc.gov/nicc");
      const r = nicc(h);
      if (r.pl) return { pl: r.pl, asOf: r.asOf, source: "NICC (nifc.gov/nicc)", tried };
      notListed = r.notListed;
      tried.push(r.notListed ? "NICC: the GACC Preparedness Levels table is empty today" : "NICC: no Southwest row found"); debug.push(`--- nifc.gov/nicc ---\n${text(h).slice(0, 3000)}`);
    } catch (e) { tried.push(`NICC: ${e.message}`); }
    try {
      const h = await get("https://gacc.nifc.gov/swcc/");
      const r = swcc(h);
      if (r.pl) return { pl: r.pl, asOf: "", source: "SWCC (gacc.nifc.gov/swcc)", tried };
      tried.push("SWCC: no number under the Preparedness Level header"); debug.push(`--- gacc.nifc.gov/swcc (under the PL header) ---\n${r.segment.slice(0, 3000)}`);
    } catch (e) { tried.push(`SWCC: ${e.message}`); }
    return { pl: null, asOf: "", source: "", tried, notListed, debug: debug.join("\n\n") };
  }
  return { fetchActual };
}

module.exports = { makeActualPl, nicc, swcc };
