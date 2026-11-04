/*
 * SWA Preparedness Level — automatic data sources.
 *
 *  • NPSG 7-Day Significant Fire Potential (fsapps.nwcg.gov ArcGIS map service)
 *  • FEMS NFDRS observations, fuel model Y: previous day's ERC and BI, averaged per PSA,
 *    with percentiles from each station's FEMS climatology.
 *
 * Runs in the browser and in Node 18+ (scripts/update-data.mjs). Every function takes the
 * config and an optional fetch implementation, so it can be tested without the network.
 */
(function (root) {
  "use strict";

  const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pad = (n) => String(n).padStart(2, "0");

  function makeSources(C, fetchImpl) {
    const A = C.autoData;
    const doFetch = (...args) => (fetchImpl || root.fetch)(...args);

    /* ---------- generic helpers ---------- */
    async function getJson(url, opts) {
      let r;
      try { r = await doFetch(url, opts); }
      catch (e) { throw new Error(`Could not reach ${new URL(url).host} (${e.message}).`); }
      if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status} ${r.statusText || ""}`.trim());
      return r.json();
    }
    async function arcQuery(layerUrl, where, outFields) {
      const q = new URLSearchParams({ where, outFields, returnGeometry: "false", f: "json" });
      const j = await getJson(`${layerUrl}/query?${q}`);
      if (j.error) throw new Error(`Map service error: ${j.error.message || JSON.stringify(j.error)}`);
      return (j.features || []).map((f) => f.attributes || {});
    }
    function localDateParts(date, tz) {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const g = (t) => p.find((x) => x.type === t).value;
      return `${g("year")}-${g("month")}-${g("day")}`;
    }
    function previousDay(now = new Date()) {
      const today = localDateParts(now, A.timeZone);
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const nowStamp = () => { const d = new Date(); return `${localDateParts(d, A.timeZone)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

    /* ---------- NPSG 7-Day ---------- */
    /* drynesscode 1 = little/no risk (green), 2 = low (yellow), 3 = moderate (brown).
       type CRITICAL (critical burn environment) or IGNITION (ignition trigger) = high risk (4). */
    function outlookLevel(a) {
      const type = String(a.type || "").toUpperCase();
      if (type === "CRITICAL" || type === "IGNITION") return 4;
      const d = parseInt(a.drynesscode, 10);
      return d >= 1 && d <= 3 ? d : null;
    }
    async function fetchOutlook() {
      const ids = Object.fromEntries(C.psas.map((p) => [normId(p.id), p.id]));
      const values = {};
      for (const p of C.psas) values[p.id] = Array(7).fill(null);
      let startDate = null;
      const days = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((layer) =>
        arcQuery(`${A.npsg.outlookService}/${layer}`, A.npsg.psaWhere, "nat_code,drynesscode,type,isvalid,timestampdate")));
      days.forEach((feats, day) => {
        for (const a of feats) {
          const id = ids[normId(a.nat_code)];
          if (!id) continue;
          const lvl = outlookLevel(a);
          // a PSA can have several polygons; keep the highest level
          if (lvl !== null && (values[id][day] === null || lvl > values[id][day])) values[id][day] = lvl;
          if (day === 0 && a.timestampdate && !startDate) startDate = new Date(a.timestampdate).toISOString().slice(0, 10);
        }
      });
      const missing = [];
      for (const p of C.psas) values[p.id] = values[p.id].map((v, d) => { if (v === null) { missing.push(`${p.id} day ${d + 1}`); return 1; } return v; });
      if (missing.length === C.psas.length * 7) throw new Error("The NPSG 7-Day service returned no Southwest PSAs.");
      return { startDate: startDate || localDateParts(new Date(), A.timeZone), values, updated: startDate,
        source: "NPSG 7-Day (auto)", fetchedAt: nowStamp(), missing };
    }

    /* ---------- FEMS ---------- */
    async function gql(query) {
      const j = await getJson(A.fems.endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query }),
      });
      if (j.errors && j.errors.length) throw new Error(`FEMS: ${j.errors.map((e) => e.message).join("; ")}`);
      return j.data;
    }
    // The FEMS guides spell the page-size argument both ways; try one, fall back to the other.
    let pageArg = "per_page";
    async function gqlPaged(build, key) {
      const out = [];
      for (let page = 0; page < 50; page++) {
        let data;
        try { data = await gql(build(page, pageArg)); }
        catch (e) {
          if (page === 0 && /per_?page|perPage|Unknown argument/i.test(e.message)) {
            pageArg = pageArg === "per_page" ? "perPage" : "per_page";
            data = await gql(build(page, pageArg));
          } else throw e;
        }
        const res = data[key] || {};
        out.push(...(res.data || []));
        const pc = (res._metadata || {}).page_count;
        if (!pc || page + 1 >= pc) break;
      }
      return out;
    }

    /* Stations per PSA: overrides from config, otherwise NPSG Key RAWS. Keyed by ERC id (SW-01). */
    async function fetchStations() {
      const ercIds = Object.fromEntries(C.psas.map((p) => [normId(p.ercId), p.ercId]));
      const out = {};
      for (const p of C.psas) out[p.ercId] = [];
      if (A.stationOverrides && Object.keys(A.stationOverrides).length) {
        for (const [k, ids] of Object.entries(A.stationOverrides)) {
          const e = ercIds[normId(k)]; if (e) out[e] = ids.map((id) => ({ id: parseInt(id, 10), name: "" }));
        }
        return out;
      }
      const feats = await arcQuery(A.npsg.keyRawsLayer, A.npsg.stationWhere, "STATION_ID,STA_NAME,NAT_CODE");
      for (const a of feats) {
        const e = ercIds[normId(a.NAT_CODE)];
        const id = parseInt(a.STATION_ID, 10);
        if (e && Number.isFinite(id)) out[e].push({ id, name: a.STA_NAME || "" });
      }
      return out;
    }

    /* Each station's ERC / BI values at the configured percentile levels. */
    async function fetchClimatology(stations) {
      const all = [...new Set(Object.values(stations).flat().map((s) => s.id))];
      const levels = A.fems.percentileLevels.join(",");
      const out = {};
      const chunk = 20;
      for (let i = 0; i < all.length; i += chunk) {
        const ids = all.slice(i, i + chunk).join(",");
        const rows = await gqlPaged((page, pa) => `query { percentileLevels(stationIds: "${ids}", fuelModel: "${A.fems.fuelModel}", percentileLevels: "${levels}", page: ${page}, ${pa}: 200) {
          _metadata { page per_page total_count page_count } data { station_id energy_release_component burning_index } } }`, "percentileLevels");
        for (const r of rows) out[r.station_id] = { erc: parseLevels(r.energy_release_component), bi: parseLevels(r.burning_index) };
      }
      return { fuelModel: A.fems.fuelModel, levels: A.fems.percentileLevels, builtAt: nowStamp(), stations, byStation: out };
    }
    function parseLevels(obj) {
      if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch (e) { return []; } }
      const out = [];
      for (const [k, v] of Object.entries(obj || {})) {
        const p = parseFloat(k); const n = parseFloat(v);
        if (Number.isFinite(p) && Number.isFinite(n)) out.push([p, n]);
      }
      return out.sort((a, b) => a[0] - b[0]);
    }
    /* Percentile of a value against [percentile, value] pairs, by linear interpolation. */
    function percentileOf(value, pairs) {
      if (!pairs || pairs.length < 2 || !Number.isFinite(value)) return null;
      if (value <= pairs[0][1]) return Math.max(0, Math.round(pairs[0][0] * value / (pairs[0][1] || 1)));
      for (let i = 1; i < pairs.length; i++) {
        const [p0, v0] = pairs[i - 1], [p1, v1] = pairs[i];
        if (value <= v1) return Math.round(v1 === v0 ? p1 : p0 + ((value - v0) / (v1 - v0)) * (p1 - p0));
      }
      return Math.min(100, pairs[pairs.length - 1][0]);
    }
    /* PSA climatology = station thresholds averaged level by level. */
    function averagePairs(list) {
      list = list.filter((p) => p && p.length);
      if (!list.length) return null;
      const levels = list[0].map((p) => p[0]);
      return levels.map((lvl) => {
        const vals = list.map((pairs) => (pairs.find((p) => p[0] === lvl) || [])[1]).filter(Number.isFinite);
        return [lvl, vals.reduce((a, b) => a + b, 0) / vals.length];
      });
    }

    /* Previous day's fuel model Y observations, one value per station (closest to obsHour local). */
    async function fetchObservations(stationIds, date) {
      const ids = stationIds.join(",");
      const rows = await gqlPaged((page, pa) => `query { nfdrsObs(fuelModels: "${A.fems.fuelModel}", nfdrType: "O", stationIds: "${ids}", startDateRange: "${date}", endDateRange: "${addDays(date, 1)}", page: ${page}, ${pa}: 1000) {
        _metadata { page per_page total_count page_count } data { station_id station_name observation_time observation_time_lst nfdr_date nfdr_time nfdr_type fuel_model energy_release_component burning_index } } }`, "nfdrsObs");
      const best = {};
      for (const r of rows) {
        if (r.nfdr_type && String(r.nfdr_type).toUpperCase() !== "O") continue;
        const t = localTime(r);
        if (!t || t.date !== date) continue;
        const erc = parseFloat(r.energy_release_component), bi = parseFloat(r.burning_index);
        if (!Number.isFinite(erc) && !Number.isFinite(bi)) continue;
        const dist = Math.abs(t.hour - A.fems.obsHour);
        const cur = best[r.station_id];
        if (!cur || dist < cur.dist) best[r.station_id] = { dist, id: r.station_id, name: r.station_name || "", time: `${t.date} ${pad(t.hour)}:00`, erc, bi };
      }
      return best;
    }
    function localTime(r) {
      const s = r.observation_time_lst || "";
      let m = String(s).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2})/);
      if (m) return { date: m[1], hour: +m[2] };
      if (r.observation_time) {
        const d = new Date(r.observation_time);
        if (!isNaN(d)) {
          const p = new Intl.DateTimeFormat("en-CA", { timeZone: A.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
          const g = (t) => p.find((x) => x.type === t).value;
          return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: +g("hour") };
        }
      }
      if (r.nfdr_date) return { date: String(r.nfdr_date).slice(0, 10), hour: +(r.nfdr_time ?? A.fems.obsHour) };
      return null;
    }

    /* PSA averages for the previous day. climatology (optional) is a cached fetchClimatology() result. */
    async function fetchDanger({ date, climatology } = {}) {
      date = date || previousDay();
      const stations = (climatology && climatology.stations) || await fetchStations();
      const allIds = [...new Set(Object.values(stations).flat().map((s) => s.id))];
      if (!allIds.length) throw new Error("No stations found for the Southwest PSAs.");
      const obs = await fetchObservations(allIds, date);
      const rows = {}, detail = [];
      const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : "");
      for (const p of C.psas) {
        const list = (stations[p.ercId] || []).map((s) => ({ ...s, ...(obs[s.id] || {}), name: s.name || (obs[s.id] || {}).name || "" }));
        const ercs = list.map((s) => s.erc).filter(Number.isFinite);
        const bis = list.map((s) => s.bi).filter(Number.isFinite);
        const ercVal = avg(ercs), biVal = avg(bis);
        let ercPct = "", biPct = "";
        if (climatology && climatology.byStation) {
          const withData = list.filter((s) => climatology.byStation[s.id]);
          const ercClim = averagePairs(withData.map((s) => climatology.byStation[s.id].erc));
          const biClim = averagePairs(withData.map((s) => climatology.byStation[s.id].bi));
          if (ercVal !== "") ercPct = percentileOf(ercVal, ercClim) ?? "";
          if (biVal !== "") biPct = percentileOf(biVal, biClim) ?? "";
        }
        rows[p.ercId] = { ercVal, biVal, ercPct, biPct, stations: ercs.length, stationsListed: list.length };
        for (const s of list) detail.push({ psa: p.ercId, id: s.id, name: s.name, time: s.time || "", erc: s.erc ?? "", bi: s.bi ?? "" });
      }
      return { date, rows, stations: detail, source: `FEMS fuel model ${A.fems.fuelModel} observations (auto)`, fetchedAt: nowStamp(),
        percentiles: climatology ? `Station climatology from FEMS, built ${climatology.builtAt}` : "" };
    }

    return { fetchOutlook, fetchStations, fetchClimatology, fetchObservations, fetchDanger,
      outlookLevel, percentileOf, averagePairs, previousDay, parseLevels };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeSources;
  else root.PL_SOURCES = makeSources(root.PL_CONFIG);
})(typeof window !== "undefined" ? window : globalThis);
