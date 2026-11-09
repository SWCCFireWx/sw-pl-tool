/*
 * SWA Preparedness Level — automatic data sources.
 *
 *  • NPSG 7-Day Significant Fire Potential (fsapps.nwcg.gov ArcGIS map service)
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
    const nowStamp = () => {
      const p = new Intl.DateTimeFormat("en-CA", { timeZone: A.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
      const g = (t) => p.find((x) => x.type === t).value;
      return `${localDateParts(new Date(), A.timeZone)}T${g("hour")}:${g("minute")}`;
    };

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

    return { fetchOutlook, outlookLevel, previousDay };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeSources;
  else root.PL_SOURCES = makeSources(root.PL_CONFIG);
})(typeof window !== "undefined" ? window : globalThis);
