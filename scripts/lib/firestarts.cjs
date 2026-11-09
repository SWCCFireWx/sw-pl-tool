// New wildfire starts in the Southwest Area from WFIGS (NIFC), by day, cause and PSA.
// Fires are placed in a PSA by their point of origin, using the PSA outlines from the NPSG map service.
"use strict";

const pad = (n) => String(n).padStart(2, "0");

/* ---------- dates (America/Denver days in UTC) ---------- */
function localParts(ms, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}`, hour: +g("hour") };
}
function localMidnightUtc(iso, tz) {
  const [y, m, d] = iso.split("-").map(Number);
  for (let off = 0; off <= 14; off++) {
    for (const sign of [1, -1]) {
      const t = Date.UTC(y, m - 1, d, 0) + sign * off * 36e5;
      const lp = localParts(t, tz);
      if (lp.date === iso && lp.hour === 0) return t;
    }
  }
  return Date.UTC(y, m - 1, d, 7);
}
function addDays(iso, n) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const sqlTs = (ms) => { const d = new Date(ms); return `TIMESTAMP '${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00'`; };

/* ---------- point in polygon (even-odd over all rings) ---------- */
function inRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function makeFireStarts(C, fetchImpl = globalThis.fetch) {
  const F = C.autoData.fireStarts;
  const tz = C.autoData.timeZone;
  async function getJson(url) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`Map service error: ${j.error.message || JSON.stringify(j.error)}`);
    return j;
  }
  async function queryAll(layer, params) {
    const out = [];
    for (let offset = 0, page = 0; page < 40; page++) {
      const q = new URLSearchParams({ f: "json", ...params, resultOffset: String(offset), resultRecordCount: "2000" });
      const j = await getJson(`${layer}/query?${q}`);
      out.push(...(j.features || []));
      if (!j.exceededTransferLimit || !(j.features || []).length) break;
      offset += j.features.length;
    }
    return out;
  }

  /* PSA outlines: { "SW-01": [[ [x,y], … ], …], … } */
  async function fetchPsaPolygons() {
    const feats = await queryAll(`${C.autoData.npsg.outlookService}/0`, {
      where: C.autoData.npsg.psaWhere, outFields: "nat_code", returnGeometry: "true", outSR: "4326", maxAllowableOffset: "0.005",
    });
    const ids = Object.fromEntries(C.psas.map((p) => [p.id.toUpperCase(), p.ercId]));
    const polys = {};
    for (const f of feats) {
      const id = ids[String((f.attributes || {}).nat_code || "").toUpperCase().replace(/[^A-Z0-9]/g, "")];
      if (!id || !f.geometry || !f.geometry.rings) continue;
      (polys[id] = polys[id] || []).push(...f.geometry.rings);
    }
    if (!Object.keys(polys).length) throw new Error("No PSA outlines returned by the NPSG map service.");
    return polys;
  }
  const psaAt = (polys, x, y) => {
    for (const [id, rings] of Object.entries(polys)) if (inRings(x, y, rings)) return id;
    return "";
  };

  /* Field names differ a little between WFIGS layers (some carry an "attr_" prefix); look them up. */
  async function fieldMap(layer) {
    const meta = await getJson(`${layer}?f=json`);
    const names = (meta.fields || []).map((f) => f.name);
    const find = (re) => names.find((n) => re.test(n)) || null;
    const m = {
      discovery: find(/(^|_)FireDiscoveryDateTime$/i), cause: find(/(^|_)FireCause$/i), causeGeneral: find(/(^|_)FireCauseGeneral$/i),
      state: find(/(^|_)POOState$/i), type: find(/(^|_)IncidentTypeCategory$/i), name: find(/(^|_)IncidentName$/i),
      id: find(/(^|_)UniqueFireIdentifier$/i) || find(/(^|_)IrwinID$/i), dispatch: find(/(^|_)POODispatchCenterID$/i),
      size: find(/(^|_)IncidentSize$/i) || find(/(^|_)DailyAcres$/i) || find(/(^|_)CalculatedAcres$/i) || find(/(^|_)DiscoveryAcres$/i),
      lat: find(/(^|_)InitialLatitude$/i), lon: find(/(^|_)InitialLongitude$/i),
    };
    if (!m.discovery || !m.cause) throw new Error(`WFIGS layer is missing the discovery date or cause field (fields: ${names.slice(0, 12).join(", ")}…).`);
    return m;
  }

  const category = (raw) => F.causes[String(raw || "").trim()] || (/natural|lightning/i.test(raw || "") ? "lightning" : /human/i.test(raw || "") ? "human" : "unknown");

  /* Starts discovered on the local days from..to (inclusive). */
  async function fetchStarts({ from, to, polygons } = {}) {
    to = to || addDays(localParts(Date.now(), tz).date, -1);
    from = from || addDays(to, -(F.lookbackDays - 1));
    const t0 = localMidnightUtc(from, tz), t1 = localMidnightUtc(addDays(to, 1), tz);
    let layer = F.service, m;
    try { m = await fieldMap(layer); }
    catch (e) { if (!F.fallbackService) throw e; layer = F.fallbackService; m = await fieldMap(layer); }
    const where = [`${m.discovery} >= ${sqlTs(t0)}`, `${m.discovery} < ${sqlTs(t1)}`];
    if (m.state && F.states.length) where.push(`${m.state} IN (${F.states.map((s) => `'${s}'`).join(",")})`);
    if (m.type && F.incidentTypes.length) where.push(`${m.type} IN (${F.incidentTypes.map((s) => `'${s}'`).join(",")})`);
    const feats = await queryAll(layer, { where: where.join(" AND "), outFields: "*", returnGeometry: "true", outSR: "4326" });
    let polys = polygons;
    if (polys === undefined) { try { polys = await fetchPsaPolygons(); } catch (e) { polys = null; } }

    const fires = [];
    for (const f of feats) {
      const a = f.attributes || {};
      const x = f.geometry && Number.isFinite(f.geometry.x) ? f.geometry.x : parseFloat(a[m.lon]);
      const y = f.geometry && Number.isFinite(f.geometry.y) ? f.geometry.y : parseFloat(a[m.lat]);
      const psa = polys && Number.isFinite(x) && Number.isFinite(y) ? psaAt(polys, x, y) : "";
      const state = m.state ? String(a[m.state] || "") : "";
      if (polys ? !psa : !/AZ|NM/.test(state)) continue; // outside the Southwest Area PSAs
      const when = typeof a[m.discovery] === "number" ? a[m.discovery] : Date.parse(a[m.discovery]);
      if (!Number.isFinite(when)) continue;
      const lp = localParts(when, tz);
      const causeRaw = String(a[m.cause] || a[m.causeGeneral] || "").trim();
      fires.push({ id: String((m.id && a[m.id]) || `${a[m.name] || "fire"}-${when}`), date: lp.date, time: lp.time,
        name: String((m.name && a[m.name]) || "").trim(), cause: category(causeRaw), causeRaw,
        acres: Number.isFinite(parseFloat(a[m.size])) ? parseFloat(a[m.size]) : "", state: state.replace(/^US-/, ""),
        dispatch: String((m.dispatch && a[m.dispatch]) || ""), psa,
        lat: Number.isFinite(y) ? Math.round(y * 1e4) / 1e4 : "", lon: Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : "" });
    }
    fires.sort((p, q) => (p.date + p.time).localeCompare(q.date + q.time));
    const daily = {};
    for (let d = from; d <= to; d = addDays(d, 1)) daily[d] = summarize(fires.filter((f) => f.date === d));
    return { from, to, daily, fires, placedByPsa: Boolean(polys), layer };
  }
  function summarize(list) {
    const s = { total: list.length, lightning: 0, human: 0, unknown: 0, acres: 0, byPsa: {} };
    for (const f of list) {
      s[f.cause]++;
      if (f.acres !== "") s.acres += f.acres;
      const b = (s.byPsa[f.psa || "?"] = s.byPsa[f.psa || "?"] || { total: 0, lightning: 0, human: 0, unknown: 0 });
      b.total++; b[f.cause]++;
    }
    s.acres = Math.round(s.acres * 10) / 10;
    return s;
  }

  const yesterday = () => addDays(localParts(Date.now(), tz).date, -1);
  return { fetchStarts, fetchPsaPolygons, inRings, localMidnightUtc, category, summarize, yesterday };
}

module.exports = { makeFireStarts, localParts, addDays, localMidnightUtc };
