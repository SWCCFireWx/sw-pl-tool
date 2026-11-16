// Previous-day RAWS summaries per PSA from FEMS public weather observations (weatherObs, no key).
// Weather: every RAWS FEMS lists in AZ/NM/TX/OK that sits inside a Southwest PSA (by lat/lon).
// ERC/BI (fuel model Y): only the SWCC station list in autoData.raws.nfdrStationsByPsa.
// Per station: max temperature, min RH, max peak gust (or max sustained wind), 24-h precipitation.
// Every reading goes through the quality checks in wxcheck.cjs; what they remove is listed in `checks`.
"use strict";
const { localMidnightUtc, addDays, makeFireStarts } = require("./firestarts.cjs");

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : "");
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const { checkStationDay, checkNeighbours, LIMITS } = require("./wxcheck.cjs");
const stationDay = checkStationDay;

function makeRaws(C, fetchImpl = globalThis.fetch) {
  const W = C.autoData.raws, tz = C.autoData.timeZone;
  const FS = makeFireStarts(C, fetchImpl);

  async function getJson(url, opts) {
    let r;
    try { r = await fetchImpl(url, opts); }
    catch (e) { throw new Error(`Could not reach ${new URL(url).host} (${e.message}).`); }
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r.json();
  }

  /* Weather stations: every RAWS FEMS lists in the configured states, placed in a PSA by location.
     Returns { "SW-01": [{ id, name, lat, lon }], … }. */
  async function stationMeta(state) {
    const out = [];
    for (let page = 0; page < 30; page++) {
      const query = `query { stationMetaData(networkName: "${W.weatherNetwork}", stateId: "${state}", page: ${page}, per_page: 1000) { _metadata { page per_page total_count page_count } data { station_id station_name state latitude longitude station_status } } }`;
      const j = await getJson(W.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query }) });
      if (j.errors && j.errors.length) throw new Error(`FEMS station list: ${j.errors.map((e) => e.message).join("; ")}`);
      const res = (j.data || {}).stationMetaData || {};
      out.push(...(res.data || []));
      const pc = (res._metadata || {}).page_count;
      if (!pc || page + 1 >= pc) break;
    }
    return out;
  }
  async function fetchStations({ polygons } = {}) {
    const polys = polygons || await FS.fetchPsaPolygons();
    const out = Object.fromEntries(C.psas.map((p) => [p.ercId, []]));
    const seen = new Set();
    for (const st of W.weatherStates) {
      for (const m of await stationMeta(st)) {
        const id = parseInt(m.station_id, 10), lat = parseFloat(m.latitude), lon = parseFloat(m.longitude);
        if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon) || seen.has(id)) continue;
        if (m.station_status && /inactive|retired|closed/i.test(m.station_status)) continue;
        const psa = Object.keys(polys).find((k) => FS.inRings(lon, lat, polys[k]));
        if (!psa) continue;
        seen.add(id);
        out[psa].push({ id, name: m.station_name || "", lat, lon });
      }
    }
    if (!seen.size) throw new Error(`FEMS listed no ${W.weatherNetwork} stations inside the Southwest PSAs.`);
    return out;
  }
  /* ERC/BI stations: the fixed SWCC list in js/config.js (plus "Other"). */
  function nfdrStations() {
    return Object.fromEntries(Object.entries(W.nfdrStationsByPsa).map(([k, list]) => [k, list.map(([id, name]) => ({ id, name }))]));
  }

  let withFlags = true;
  async function weatherObs(ids, t0, t1) {
    const rows = [];
    for (let page = 0; page < 30; page++) {
      const fields = `station_id station_name observation_time observation_type temperature relative_humidity hourly_precip wind_speed peak_gust_speed${withFlags ? " t_flag rh_flag pcp_flag ws_flag gs_flag" : ""}`;
      const query = `query { weatherObs(startDateTimeRange: "${iso(t0)}", endDateTimeRange: "${iso(t1 - 1000)}", stationIds: "${ids.join(",")}", timeZone: "${tz}", page: ${page}, per_page: 1000) { _metadata { page per_page total_count page_count } data { ${fields} } } }`;
      const j = await getJson(W.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query }) });
      if (j.errors && j.errors.length) {
        const msg = j.errors.map((e) => e.message).join("; ");
        if (withFlags && /flag/i.test(msg)) { withFlags = false; page--; continue; } // older schema without QC flags
        throw new Error(`FEMS: ${msg}`);
      }
      const res = (j.data || {}).weatherObs || {};
      rows.push(...(res.data || []));
      const pc = (res._metadata || {}).page_count;
      if (!pc || page + 1 >= pc) break;
    }
    return rows;
  }

  /* date: local day (YYYY-MM-DD), default yesterday */
  async function fetchRaws({ date, stations } = {}) {
    if (!date) date = addDays(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()), -1);
    stations = stations || await fetchStations();
    const t0 = localMidnightUtc(date, tz), t1 = localMidnightUtc(addDays(date, 1), tz);
    const all = [...new Set(Object.values(stations).flat().map((s) => s.id))];
    const obs = {};
    for (let i = 0; i < all.length; i += 25) {
      for (const r of await weatherObs(all.slice(i, i + 25), t0, t1)) {
        if (r.observation_type && String(r.observation_type).toUpperCase() !== "O") continue;
        (obs[r.station_id] = obs[r.station_id] || { name: r.station_name || "", rows: [] }).rows.push(r);
      }
    }
    const byPsa = {}, list = [], checks = [];
    for (const p of C.psas) {
      const listed = (W.windEvents || []).some((e) => e.date === date && (e.psa === "all" || String(e.psa).replace(/[^A-Z0-9]/gi, "").toUpperCase() === p.ercId.replace(/-/g, "")));
      const days = checkNeighbours((stations[p.ercId] || []).filter((s) => obs[s.id]).map((s) => Object.assign(checkStationDay(obs[s.id].rows), { id: s.id, name: s.name || obs[s.id].name })), { windEvent: listed });
      for (const d of days) for (const i of d.issues) checks.push({ psa: p.ercId, id: d.id, name: d.name, ...i });
      const f = (k) => days.map((d) => d[k]).filter(Number.isFinite);
      const avg = (k) => (f(k).length ? f(k).reduce((a, b) => a + b, 0) / f(k).length : NaN);
      byPsa[p.ercId] = {
        stations: days.length, stationsListed: (stations[p.ercId] || []).length,
        avgMaxTemp: r1(avg("maxTemp")), avgMinRh: r1(avg("minRh")),
        lowestRh: r1(f("minRh").length ? Math.min(...f("minRh")) : NaN), maxGust: r1(f("maxGust").length ? Math.max(...f("maxGust")) : NaN),
        avgPrecip: r2(avg("precip")), wettingRain: f("precip").filter((v) => v >= W.wettingRain).length,
        readingsDropped: days.reduce((a, d) => a + d.issues.filter((i) => i.action === "dropped").length, 0),
        windEvent: Boolean(days.windEvent), windyStations: days.windyStations || 0,
      };
      for (const d of days) list.push({ psa: p.ercId, id: d.id, name: d.name, hours: d.hours, maxTemp: r1(d.maxTemp), minRh: r1(d.minRh), maxGust: r1(d.maxGust), precip: r2(d.precip), issues: d.issues.length });
    }
    if (!list.length) throw new Error(`FEMS returned no weather observations for ${all.length} Southwest stations on ${date}.`);
    return { date, byPsa, stations: list, checks, source: "FEMS RAWS observations (auto, quality-checked)" };
  }
  /* ---------- NFDRS fuel model Y: previous day's ERC and BI per PSA (for the archive) ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  function localTime(r) {
    const m = String(r.observation_time_lst || "").match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2})/);
    if (m) return { date: m[1], hour: +m[2] };
    const ms = Date.parse(r.observation_time || "");
    if (Number.isFinite(ms)) {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
      const g = (t) => p.find((x) => x.type === t).value;
      return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: +g("hour") };
    }
    if (r.nfdr_date) return { date: String(r.nfdr_date).slice(0, 10), hour: parseInt(r.nfdr_time, 10) || 13 };
    return null;
  }
  async function nfdrsObs(ids, date) {
    const rows = [];
    for (let page = 0; page < 30; page++) {
      // Only fields listed for nfdrsObs in the FEMS guide (it has no station_name).
      const query = `query { nfdrsObs(stationIds: "${ids.join(",")}", fuelModels: "${W.fuelModel || "Y"}", nfdrType: "O", startDateRange: "${date}", endDateRange: "${addDays(date, 1)}", page: ${page}, per_page: 1000) { _metadata { page per_page total_count page_count } data { station_id observation_time observation_time_lst nfdr_date nfdr_time nfdr_type fuel_model energy_release_component burning_index } } }`;
      const j = await getJson(W.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ query }) });
      if (j.errors && j.errors.length) throw new Error(`FEMS: ${j.errors.map((e) => e.message).join("; ")}`);
      const res = (j.data || {}).nfdrsObs || {};
      rows.push(...(res.data || []));
      const pc = (res._metadata || {}).page_count;
      if (!pc || page + 1 >= pc) break;
    }
    return rows;
  }
  /* Per station: the reading closest to 13:00 local time, and the day's highest ERC and BI. */
  async function fetchNfdr({ date } = {}) {
    if (!date) date = addDays(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()), -1);
    const stations = nfdrStations();
    const all = [...new Set(Object.values(stations).flat().map((s) => s.id))];
    const per = {};
    for (let i = 0; i < all.length; i += 25) {
      for (const r of await nfdrsObs(all.slice(i, i + 25), date)) {
        if (r.nfdr_type && String(r.nfdr_type).toUpperCase() !== "O") continue;
        const t = localTime(r);
        if (!t || t.date !== date) continue;
        const erc = parseFloat(r.energy_release_component), bi = parseFloat(r.burning_index);
        if (!Number.isFinite(erc) && !Number.isFinite(bi)) continue;
        const s = (per[r.station_id] = per[r.station_id] || { best: null, ercMax: -Infinity, biMax: -Infinity });
        if (Number.isFinite(erc)) s.ercMax = Math.max(s.ercMax, erc);
        if (Number.isFinite(bi)) s.biMax = Math.max(s.biMax, bi);
        const dist = Math.abs(t.hour - 13);
        if (!s.best || dist < s.best.dist) s.best = { dist, hour: t.hour, erc, bi };
      }
    }
    const byPsa = {}, list = [];
    for (const p of C.psas) {
      const days = (stations[p.ercId] || []).filter((s) => per[s.id]).map((s) => ({ id: s.id, name: s.name, ...per[s.id] }));
      const avg = (fn) => { const v = days.map(fn).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
      byPsa[p.ercId] = { stations: days.length, stationsListed: (stations[p.ercId] || []).length,
        erc: r1(avg((d) => d.best.erc)), bi: r1(avg((d) => d.best.bi)), ercMax: r1(avg((d) => d.ercMax)), biMax: r1(avg((d) => d.biMax)) };
      for (const d of days) list.push({ psa: p.ercId, id: d.id, name: d.name, hour: `${pad(d.best.hour)}:00`, erc: r1(d.best.erc), bi: r1(d.best.bi), ercMax: r1(d.ercMax), biMax: r1(d.biMax) });
    }
    for (const s of stations.Other || []) {
      const d = per[s.id];
      list.push(d ? { psa: "Other", id: s.id, name: s.name, hour: `${pad(d.best.hour)}:00`, erc: r1(d.best.erc), bi: r1(d.best.bi), ercMax: r1(d.ercMax), biMax: r1(d.biMax) }
        : { psa: "Other", id: s.id, name: s.name, hour: "", erc: "", bi: "", ercMax: "", biMax: "" });
    }
    if (!list.some((x) => x.erc !== "")) throw new Error(`FEMS returned no fuel model ${W.fuelModel || "Y"} observations for ${all.length} Southwest stations on ${date}.`);
    return { date, fuelModel: W.fuelModel || "Y", byPsa, stations: list, source: "FEMS NFDRS observations (auto)" };
  }

  return { fetchRaws, fetchNfdr, fetchStations, nfdrStations, stationDay };
}

module.exports = { makeRaws, stationDay, LIMITS };
