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
      complexity: find(/(^|_)IncidentComplexityLevel$/i), org: find(/(^|_)IncidentManagementOrganization$/i),
      out: find(/(^|_)FireOutDateTime$/i), contained: find(/(^|_)ContainmentDateTime$/i), pct: find(/(^|_)PercentContained$/i),
      cpxChild: find(/(^|_)IsCpxChild$/i), cpxName: find(/(^|_)CpxName$/i) || find(/(^|_)ComplexName$/i),
      fuel: find(/(^|_)PrimaryFuelModel$/i) || find(/(^|_)PrimaryFuel/i) || find(/FuelModel/i),
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
  /* ---------- Fire Activity: active T3+ incidents ---------- */
  /* Incident type from IRWIN's complexity level, else from the management organization:
     1–5, or 2 for a complex. null when neither field says. */
  function incidentType(complexity, org) {
    const c = String(complexity || ""), o = String(org || "");
    let m = c.match(/type\s*([1-5])/i) || c.match(/^\s*([1-5])\s*$/);
    if (m) return +m[1];
    if (/complex/i.test(c) || /complex|cimt|nimo/i.test(o)) return 2;
    m = o.match(/type\s*([1-5])/i);
    return m ? +m[1] : null;
  }
  /* Incidents in the SW PSAs that aren't declared out (and, by default, not contained). */
  async function fetchActiveIncidents({ polygons } = {}) {
    const A = C.autoData.fireActivity || {};
    let layer = F.fallbackService, m; // the "current" layer holds active incidents
    try { m = await fieldMap(layer); } catch (e) { layer = F.service; m = await fieldMap(layer); }
    if (!m.complexity && !m.org) throw new Error("WFIGS has no incident complexity or management organization field, so incident types can't be counted.");
    const where = [];
    if (m.state && F.states.length) where.push(`${m.state} IN (${F.states.map((x) => `'${x}'`).join(",")})`);
    if (m.type && F.incidentTypes.length) where.push(`${m.type} IN (${F.incidentTypes.map((x) => `'${x}'`).join(",")})`);
    if (m.out) where.push(`${m.out} IS NULL`);
    const feats = await queryAll(layer, { where: where.join(" AND ") || "1=1", outFields: "*", returnGeometry: "true", outSR: "4326" });
    const polys = polygons || await fetchPsaPolygons();
    const list = [];
    for (const f of feats) {
      const a = f.attributes || {};
      if (m.cpxChild && (a[m.cpxChild] === 1 || a[m.cpxChild] === true || /^(1|true|yes)$/i.test(String(a[m.cpxChild])))) continue; // counted under its complex
      const contained = (m.contained && a[m.contained]) || (m.pct && +a[m.pct] >= 100);
      if (contained && !A.countContained) continue;
      const x = f.geometry && Number.isFinite(f.geometry.x) ? f.geometry.x : parseFloat(a[m.lon]);
      const y = f.geometry && Number.isFinite(f.geometry.y) ? f.geometry.y : parseFloat(a[m.lat]);
      const psa = Number.isFinite(x) && Number.isFinite(y) ? psaAt(polys, x, y) : "";
      if (!psa) continue;
      let type = incidentType(a[m.complexity], a[m.org]);
      const acres = Number.isFinite(parseFloat(a[m.size])) ? Math.round(parseFloat(a[m.size])) : "";
      // Backup when the complexity is blank or still Type 4/5: a fire that has reached NWCG large-fire size
      // (100 acres in timber, 300 acres in grass/brush or when the fuel isn't given) counts as a Type 3.
      const fuel = String((m.fuel && a[m.fuel]) || "");
      const largeAt = /timber|conifer|forest|slash/i.test(fuel) ? (A.largeFireAcresTimber || 100) : (A.largeFireAcresOther || 300);
      let basis = type !== null && type <= 3 ? "complexity" : "";
      if ((type === null || type >= 4) && acres !== "" && acres >= largeAt && A.largeFireByAcres !== false) { type = 3; basis = "acres"; }
      list.push({ name: String(a[m.name] || "").trim(), type, basis, complexity: String(a[m.complexity] || a[m.org] || ""), psa, fuel, largeAt,
        acres, contained: m.pct && a[m.pct] !== null && a[m.pct] !== undefined ? +a[m.pct] : "",
        discovered: Number.isFinite(+a[m.discovery]) ? localParts(+a[m.discovery], tz).date : "" });
    }
    const t3plus = list.filter((i) => i.type !== null && i.type <= 3);
    const complex = t3plus.filter((i) => i.type <= 2).length;
    // Escapes: found in the last 3 days, still uncontained past the first burning period, and 100+ acres or T3+.
    const today = localParts(Date.now(), tz).date;
    const from = addDays(today, -3), to = addDays(today, -1);
    const esc = list.filter((i) => i.discovered && i.discovered >= from && i.discovered <= to && ((+i.acres || 0) >= (A.escapeAcres || 100) || (i.type !== null && i.type <= 3)));
    return { complex, t3: t3plus.length - complex, escapes: esc.length, escapeList: esc.map((i) => i.name), incidents: t3plus.sort((p, q) => p.type - q.type || (+q.acres || 0) - (+p.acres || 0)),
      activeTotal: list.length, unknownType: list.filter((i) => i.type === null).length, layer,
      byAcres: t3plus.filter((i) => i.basis === "acres").map((i) => ({ name: i.name, acres: i.acres, psa: i.psa, complexity: i.complexity, largeAt: i.largeAt })),
      noComplexity: list.filter((i) => !i.complexity).length };
  }

  return { fetchStarts, fetchPsaPolygons, fetchActiveIncidents, incidentType, inRings, localMidnightUtc, category, summarize, yesterday };
}

module.exports = { makeFireStarts, localParts, addDays, localMidnightUtc };
