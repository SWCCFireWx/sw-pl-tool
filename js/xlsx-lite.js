/*
 * Minimal .xlsx writer (no dependencies). Builds a workbook from plain arrays and returns the
 * file as a Uint8Array. Works in the browser and in Node.
 *
 *   makeXlsx([{ name: "Sheet", cols: [20, 12], rows: [["Text", 1.5, { v: "Bold", s: "bold" }]] }])
 *
 * Cell styles: bold, head, title, sub, lv1–lv4 (7-Day colors), b0–b3 (ERCy percentile bins),
 * Minimum/Low/Moderate/High/Maximum/Extreme (rating colors).
 */
(function (root) {
  "use strict";

  const FILLS = { // ARGB
    head: "FFDDE3EC", lv1: "FF7DBB6C", lv2: "FFF1DC5A", lv3: "FFA8763F", lv4: "FFD33A32",
    b0: "FF4CAE5C", b1: "FFF4E35A", b2: "FFE5392F", b3: "FF7E1B1B",
    Minimum: "FFE3F1E4", Low: "FFE1ECF8", Moderate: "FFFBF0C9", High: "FFFDE6D6", Maximum: "FFF9DEDE", Extreme: "FFF1DBE7",
  };
  const WHITE_TEXT = new Set(["lv3", "lv4", "b2", "b3"]);
  const STYLE_NAMES = ["normal", "bold", "title", "sub", "head", ...Object.keys(FILLS).filter((k) => k !== "head")];

  function stylesXml() {
    const fillKeys = Object.keys(FILLS);
    const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>',
      ...fillKeys.map((k) => `<fill><patternFill patternType="solid"><fgColor rgb="${FILLS[k]}"/><bgColor indexed="64"/></patternFill></fill>`)];
    const fonts = ['<font><sz val="11"/><name val="Calibri"/></font>', '<font><b/><sz val="11"/><name val="Calibri"/></font>',
      '<font><b/><sz val="16"/><name val="Calibri"/></font>', '<font><i/><sz val="10"/><color rgb="FF586274"/><name val="Calibri"/></font>',
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'];
    const border = '<border><left style="thin"><color rgb="FFC9D0DA"/></left><right style="thin"><color rgb="FFC9D0DA"/></right><top style="thin"><color rgb="FFC9D0DA"/></top><bottom style="thin"><color rgb="FFC9D0DA"/></bottom><diagonal/></border>';
    const xfs = STYLE_NAMES.map((n) => {
      if (n === "normal") return '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
      if (n === "bold") return '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
      if (n === "title") return '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
      if (n === "sub") return '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>';
      const fillId = 2 + fillKeys.indexOf(n);
      const fontId = WHITE_TEXT.has(n) ? 4 : 1;
      return `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${n === "head" ? "left" : "center"}"/></xf>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${fonts.length}">${fonts.join("")}</fonts>
<fills count="${fills.length}">${fills.join("")}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
    // strip characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  function colName(i) { let s = ""; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  function sheetXml(sheet) {
    const rows = sheet.rows.map((row, r) => {
      const cells = row.map((cell, c) => {
        if (cell === null || cell === undefined || cell === "") return "";
        const o = typeof cell === "object" ? cell : { v: cell };
        const s = Math.max(0, STYLE_NAMES.indexOf(o.s || "normal"));
        const ref = `${colName(c)}${r + 1}`;
        const sAttr = s ? ` s="${s}"` : "";
        if (o.v === null || o.v === undefined || o.v === "") return s ? `<c r="${ref}"${sAttr}/>` : "";
        if (typeof o.v === "number" && Number.isFinite(o.v)) return `<c r="${ref}"${sAttr}><v>${o.v}</v></c>`;
        return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(o.v)}</t></is></c>`;
      }).join("");
      return `<row r="${r + 1}">${cells}</row>`;
    }).join("");
    const cols = sheet.cols ? `<cols>${sheet.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const merges = sheet.merges && sheet.merges.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews>${cols}<sheetData>${rows}</sheetData>${merges}</worksheet>`;
  }

  /* ---- zip (stored, no compression) ---- */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      const local = new Uint8Array([...u32(0x04034b50), ...common, ...name]);
      parts.push(local, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name]));
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
    let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
    return out;
  }

  function makeXlsx(sheets) {
    const safe = sheets.map((s, i) => ({ ...s, name: String(s.name || `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, "-").slice(0, 31) }));
    const files = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${safe.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${safe.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${safe.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${safe.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", data: stylesXml() },
      ...safe.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
    ];
    return zip(files);
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeXlsx;
  else root.PL_XLSX = makeXlsx;
})(typeof window !== "undefined" ? window : globalThis);
