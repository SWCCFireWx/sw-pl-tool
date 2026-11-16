/*
 * Minimal .xlsx reader (no dependencies) for the browser and Node.
 *   const sheets = await PL_XLSX_READ(bytes);   // { "Sheet name": () => rows }, rows = 2-D array
 * Handles shared strings, inline strings, numbers and booleans. Dates come back as Excel serial
 * numbers; excelDate() converts them.
 */
(function (root) {
  "use strict";

  const utf8 = new TextDecoder("utf-8");
  async function inflateRaw(bytes) {
    if (typeof process !== "undefined" && process.versions && process.versions.node && typeof require === "function") {
      return new Uint8Array(require("zlib").inflateRawSync(bytes));
    }
    if (typeof DecompressionStream === "undefined") throw new Error("This browser can't open .xlsx files. Save the file as .csv and upload that.");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function unzip(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("This isn't an .xlsx file. Old .xls files aren't supported: save it as .xlsx or .csv.");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("The .xlsx file looks damaged.");
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + compSize);
      files[name] = async () => utf8.decode(method === 8 ? await inflateRaw(raw) : raw);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return files;
  }

  const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    const map = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (map[e.toLowerCase()]) return map[e.toLowerCase()];
    return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  const textOf = (xml) => decode([...xml.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(""));
  function colIndex(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

  function parseSheet(xml, shared) {
    const rows = [];
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const r = parseInt((rm[1].match(/\br="(\d+)"/) || [])[1], 10) - 1;
      const row = [];
      for (const cm of rm[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const attrs = cm[1], body = cm[2] || "";
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
        const v = (body.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
        let val = null;
        if (t === "s") val = shared[parseInt(v, 10)] ?? null;
        else if (t === "inlineStr") val = textOf(body);
        else if (t === "str" || t === "e") val = v !== undefined ? decode(v) : null;
        else if (t === "b") val = v === "1";
        else if (v !== undefined) val = Number(v);
        row[ref ? colIndex(ref) : row.length] = val;
      }
      rows[Number.isFinite(r) ? r : rows.length] = row;
    }
    return Array.from(rows, (r) => r || []);
  }

  async function readXlsx(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const files = unzip(bytes);
    const need = async (n) => { if (!files[n]) throw new Error(`The workbook is missing ${n}.`); return files[n](); };
    const shared = files["xl/sharedStrings.xml"]
      ? [...(await need("xl/sharedStrings.xml")).matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textOf(m[1]))
      : [];
    const rels = {};
    for (const m of (await need("xl/_rels/workbook.xml.rels")).matchAll(/<Relationship\b[^>]*>/g)) {
      const id = (m[0].match(/\bId="([^"]+)"/) || [])[1], target = (m[0].match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && target) rels[id] = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    }
    const sheets = {};
    for (const m of (await need("xl/workbook.xml")).matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
      const name = decode((m[0].match(/\bname="([^"]*)"/) || [])[1] || "");
      const rid = (m[0].match(/\br:id="([^"]+)"/) || m[0].match(/\bid="([^"]+)"/) || [])[1];
      const path = `xl/${rels[rid]}`;
      if (!files[path]) continue;
      const xml = await files[path]();
      sheets[name] = () => parseSheet(xml, shared);
    }
    return sheets;
  }

  // Excel serial date → "YYYY-MM-DD" (other values are returned as trimmed text).
  function excelDate(v) {
    if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
    return v === null || v === undefined ? "" : String(v).trim();
  }

  const api = { readXlsx, excelDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PL_XLSX_READ = api;
})(typeof window !== "undefined" ? window : globalThis);
