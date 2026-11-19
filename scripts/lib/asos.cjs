// ASOS/AWOS airport weather stations from the Iowa Environmental Mesonet (IEM), public, no key.
//   station lists: https://mesonet.agron.iastate.edu/api/1/network/AZ_ASOS.json  (AZ/NM/TX/OK networks hold ASOS and AWOS)
//   observations:  https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py      (METARs, routine + specials)
// Each station's METARs are turned into one record per hour, in the same shape as FEMS weatherObs rows,
// so they go through exactly the same quality checks as the RAWS (wxcheck.cjs):
//   temperature / RH: the routine (hourly) report, or the last report in the hour
//   sustained wind:   that report's wind speed (knots → mph)
//   gust:             the highest gust or peak wind (PK WND) in any report that hour (knots → mph)
//   hourly precip:    the hour's precipitation (p01i) from the routine report
"use strict";
const { localMidnightUtc, addDays, makeFireStarts } = require("./firestarts.cjs");

const KT = 1.15078; // knots → mph
const pad = (n) => String(n).padStart(2, "0");

function parseCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const head = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((l) => { const c = l.split(","); return Object.fromEntries(head.map((h, i) => [h, (c[i] ?? "").trim()])); });
}
const val = (v) => { if (v === undefined || v === null || v === "" || v === "M" || v === "T") return v === "T" ? 0 : NaN; const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };

/* METAR rows for one station → one FEMS-style row per local hour. rows: [{ valid: "YYYY-MM-DD HH:MM" (UTC), … }] */
function hourly(rows, id, name) {
  const byHour = new Map();
  for (const r of rows) {
    const t = Date.parse(String(r.valid).replace(" ", "T") + ":00Z");
    if (!Number.isFinite(t)) continue;
    const h = Math.floor(t / 36e5);
    (byHour.get(h) || byHour.set(h, []).get(h)).push({ ...r, t });
  }
  const out = [];
  for (const [h, list] of [...byHour].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.t - b.t);
    // routine reports come at :45–:59; otherwise use the last report in the hour
    const routine = [...list].reverse().find((r) => new Date(r.t).getUTCMinutes() >= 45 && Number.isFinite(val(r.tmpf))) || [...list].reverse().find((r) => Number.isFinite(val(r.tmpf))) || list[list.length - 1];
    const gusts = list.flatMap((r) => [val(r.gust), val(r.peak_wind_gust)]).filter(Number.isFinite);
    const sk = val(routine.sknt);
    const p = list.map((r) => val(r.p01i)).filter(Number.isFinite);
    out.push({
      station_id: id, station_name: name, observation_type: "O",
      observation_time: new Date(h * 36e5).toISOString().replace(/\.\d{3}Z$/, "Z"),
      temperature: val(routine.tmpf), relative_humidity: Number.isFinite(val(routine.relh)) ? Math.round(val(routine.relh)) : NaN,
      wind_speed: Number.isFinite(sk) ? Math.round(sk * KT) : NaN,
      peak_gust_speed: gusts.length ? Math.round(Math.max(...gusts) * KT) : NaN,
      hourly_precip: p.length ? Math.max(...p) : NaN,
    });
  }
  return out;
}

function makeAsos(C, fetchImpl = globalThis.fetch) {
  const A = C.autoData.asos, tz = C.autoData.timeZone;
  const FS = makeFireStarts(C, fetchImpl);
  // IEM limits how often one address can ask (GitHub's runners share addresses), answering 429 "too many
  // requests" or 503. Wait and try again: as long as IEM's Retry-After says, otherwise 15, 30, 60 s.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const wait = A.retryWaitMs ?? 15000;
  const get = async (url, kind) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await fetchImpl(url, { headers: { "User-Agent": "SWA-PL-tool (SWCC predictive services)" } }); }
      catch (e) { if (attempt < 3) { await sleep(wait * 2 ** attempt); continue; } throw new Error(`Could not reach ${new URL(url).host} (${e.message}).`); }
      if ((r.status === 429 || r.status === 503) && attempt < 3) {
        const ra = parseInt((r.headers && r.headers.get && r.headers.get("retry-after")) || "", 10);
        await sleep(Number.isFinite(ra) ? Math.min(ra, 120) * 1000 : wait * 2 ** attempt);
        continue;
      }
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}${r.status === 429 ? " (too many requests) after 4 tries" : ""}`);
      if (A.pauseMs) await sleep(A.pauseMs); // be gentle between requests
      return kind === "json" ? r.json() : r.text();
    }
  };

  /* { "SW-01": [{ id: "ASOS:PHX", code: "PHX", name, lat, lon, network }], … } */
  async function fetchStations({ polygons } = {}) {
    const polys = polygons || await FS.fetchPsaPolygons();
    const out = Object.fromEntries(C.psas.map((p) => [p.ercId, []]));
    let n = 0;
    for (const net of A.networks) {
      const j = await get(`${A.base}/api/1/network/${net}.json`, "json");
      for (const s of j.data || []) {
        const lat = parseFloat(s.latitude), lon = parseFloat(s.longitude);
        if (!s.id || !Number.isFinite(lat) || !Number.isFinite(lon) || s.online === false || s.archive_end) continue;
        const psa = Object.keys(polys).find((k) => FS.inRings(lon, lat, polys[k]));
        if (!psa) continue;
        out[psa].push({ id: `ASOS:${s.id}`, code: s.id, name: String(s.name || s.id).trim(), lat, lon, network: net });
        n++;
      }
    }
    if (!n) throw new Error("IEM listed no ASOS/AWOS stations inside the Southwest PSAs.");
    return out;
  }

  /* Hourly rows for one local day: { "ASOS:PHX": { name, rows } } */
  async function fetchObs(stations, date) {
    const t0 = localMidnightUtc(date, tz), t1 = localMidnightUtc(addDays(date, 1), tz);
    const d0 = new Date(t0), d1 = new Date(t1 + 36e5); // asos.py end date is exclusive: one hour past the local day
    const all = Object.values(stations).flat();
    const byCode = new Map(all.map((s) => [s.code, s]));
    const obs = {};
    const codes = [...byCode.keys()];
    for (let i = 0; i < codes.length; i += A.perRequest) {
      const q = new URLSearchParams();
      for (const c of codes.slice(i, i + A.perRequest)) q.append("station", c);
      for (const f of ["tmpf", "relh", "sknt", "gust", "p01i", "peak_wind_gust"]) q.append("data", f);
      q.set("year1", d0.getUTCFullYear()); q.set("month1", d0.getUTCMonth() + 1); q.set("day1", d0.getUTCDate()); q.set("hour1", d0.getUTCHours()); q.set("minute1", 0);
      q.set("year2", d1.getUTCFullYear()); q.set("month2", d1.getUTCMonth() + 1); q.set("day2", d1.getUTCDate()); q.set("hour2", d1.getUTCHours()); q.set("minute2", 0);
      q.set("tz", "Etc/UTC"); q.set("format", "onlycomma"); q.set("latlon", "no"); q.set("elev", "no");
      q.set("missing", "empty"); q.set("trace", "0.0001"); q.set("direct", "no"); q.set("report_type", "3,4");
      const rows = parseCsv(await get(`${A.base}/cgi-bin/request/asos.py?${q}`, "text"));
      const per = {};
      for (const r of rows) (per[r.station] = per[r.station] || []).push(r);
      for (const [code, list] of Object.entries(per)) {
        const s = byCode.get(code);
        if (!s) continue;
        const hrs = hourly(list, s.id, s.name).filter((h) => { const t = Date.parse(h.observation_time); return t >= t0 && t < t1; });
        if (hrs.length) obs[s.id] = { name: s.name, rows: hrs };
      }
    }
    return obs;
  }
  return { fetchStations, fetchObs };
}

module.exports = { makeAsos, hourly, parseCsv, KT };
