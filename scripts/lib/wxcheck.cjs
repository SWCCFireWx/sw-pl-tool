// Quality checks for one day of hourly RAWS observations.
//
// Each check removes the bad reading (or the day's value) and records why, so the archive shows what was
// thrown out. Thresholds are loose on purpose: they catch sensor faults, not real weather.
//
//  Hourly checks (per station)
//   1. FEMS QC flag 2 ("suspicious")
//   2. Outside physical limits (LIMITS)
//   3. Stuck sensor: temperature or RH identical for 12+ hours
//   4. Spike: one hour jumps away from both neighbouring hours, which agree with each other
//      (temperature, RH, sustained wind)
//   5. Daily rain over MAX_DAILY_PRECIP (gauge reset)
//
//  Wind: real wind events stay in, sensor faults come out. A gust looks odd when it is far above the
//  sustained wind (3 × wind + 30), jumps 40+ mph above the hours either side, is over SUSPECT_GUST (75 mph),
//  or is far above every other station in the PSA. An odd gust is only kept when something backs it up AT
//  A SIMILAR STRENGTH (a 125 mph gust is not backed up by a 43 mph gust next door):
//   • up to 75 mph: the station's own sustained wind is ≥ 40% of the gust (and ≥ 25 mph), the hour before
//     or after gusted ≥ 70% of it, an outflow signature (temperature drop ≥ 10 °F, RH jump ≥ 15, rain),
//     or another station (RAWS or ASOS/AWOS) in the PSA gusted ≥ 60% of it within 2 hours;
//   • 75–90 mph: the same, except an outflow signature alone is not enough;
//   • over 90 mph: another station in the PSA must have gusted ≥ half of it (and ≥ 45 mph) within 2 hours.
//  A day and PSA listed in autoData.raws.windEvents in js/config.js keeps gusts up to the hard limit.
//  Gusts above LIMITS.peak_gust_speed (130 mph) are always removed.
//  A PSA counts as having a wind event only when 2+ stations (or a quarter of them) keep gusts ≥ 40 mph
//  after these checks.
"use strict";

const LIMITS = {
  temperature: [-40, 125],     // °F
  relative_humidity: [1, 100], // %  (0 % is a sensor fault)
  wind_speed: [0, 80],         // mph
  peak_gust_speed: [0, 130],   // mph, hard limit
  hourly_precip: [0, 2],       // inches in one hour
};
const QC_FLAG = { temperature: "t_flag", relative_humidity: "rh_flag", wind_speed: "ws_flag", peak_gust_speed: "gs_flag", hourly_precip: "pcp_flag" };
const SPIKE = { temperature: 20, relative_humidity: 40, wind_speed: 30 }; // jump vs both neighbours
const GUST = { factor: 3, plus: 30, spike: 40 };   // gust looks odd above 3 × wind + 30, or 40 mph above both neighbours
const SUSPECT_GUST = 75;                            // above this, an outflow signature alone isn't enough
const EXTREME_GUST = 90;                            // above this, only another station can back it up
const BACKING = { sustainedShare: 0.4, adjacentShare: 0.7, nearbyShare: 0.6, extremeNearbyShare: 0.5, extremeNearbyMin: 45 };
const WIND_EVENT = { gust: 40, sustained: 25, nearbyHours: 2, outflowTempDrop: 10, outflowRhJump: 15 };
const STUCK_HOURS = 12;
const MAX_DAILY_PRECIP = 6;                         // inches
const NEIGHBOUR = { maxTemp: 30, minRh: 30, maxGust: 40 }; // allowed distance from the PSA median
const LABEL = { temperature: "temperature", relative_humidity: "RH", wind_speed: "wind", peak_gust_speed: "gust", hourly_precip: "hourly rain" };

const num = (v) => (v === null || v === undefined || v === "" ? NaN : +v);
const hourNumber = (r) => { const t = Date.parse(r.observation_time || ""); return Number.isFinite(t) ? Math.round(t / 36e5) : NaN; };
const hourOf = (r) => String(r.observation_time_lst || r.observation_time || "").slice(11, 16);
const fin = (a) => a.filter(Number.isFinite);
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* Reasons the station's own data backs up a gust at hour i, or "" if none. Gusts over EXTREME_GUST
   can't be backed up by the station alone; over SUSPECT_GUST an outflow signature isn't enough. */
function ownSupport(d, i, g = d.rawGust[i]) {
  if (!(g <= EXTREME_GUST)) return "";
  const S = d.series;
  const w = S.wind_speed[i];
  if (w >= WIND_EVENT.sustained && w >= BACKING.sustainedShare * g) return `sustained wind ${w} mph`;
  for (const j of [i - 1, i + 1]) {
    const gj = d.rawGust[j];
    if (Number.isFinite(gj) && gj >= WIND_EVENT.gust && gj >= BACKING.adjacentShare * g) return `${gj} mph gust the ${j < i ? "hour before" : "hour after"}`;
  }
  if (g > SUSPECT_GUST) return "";
  for (const j of [i - 1, i, i + 1]) {
    if (j < 1 || j >= S.temperature.length) continue;
    const dT = S.temperature[j - 1] - S.temperature[j], dRH = S.relative_humidity[j] - S.relative_humidity[j - 1];
    if (dT >= WIND_EVENT.outflowTempDrop) return `temperature fell ${Math.round(dT)} °F (outflow)`;
    if (dRH >= WIND_EVENT.outflowRhJump) return `RH jumped ${Math.round(dRH)} points (outflow)`;
    if (S.hourly_precip[j] > 0) return "rain at the same time";
  }
  return "";
}
/* Smallest gust at another station that backs up a gust of g mph. */
const nearbyNeeded = (g) => g > EXTREME_GUST ? Math.max(BACKING.extremeNearbyMin, BACKING.extremeNearbyShare * g) : Math.max(WIND_EVENT.gust, BACKING.nearbyShare * g);

/* rows: one station's hourly records for the day. Returns daily values and the problems found.
   Odd gusts the station's own data can't back up are held back as `pending`; checkNeighbours()
   restores them if nearby stations or a PSA-wide wind event back them up. */
function checkStationDay(rows) {
  rows = [...rows].sort((a, b) => String(a.observation_time).localeCompare(String(b.observation_time)));
  const issues = [];
  const note = (field, value, reason, r, action = "dropped") => { const it = { field, value, reason, hour: r ? hourOf(r) : "", action }; issues.push(it); return it; };
  const series = {};
  for (const k of Object.keys(LIMITS)) {
    series[k] = rows.map((r) => {
      const v = num(r[k]);
      if (!Number.isFinite(v)) return NaN;
      if (+(r[QC_FLAG[k]] ?? 0) === 2) { note(LABEL[k], v, "FEMS flagged it as suspicious", r); return NaN; }
      const [lo, hi] = LIMITS[k];
      if (v < lo || v > hi) { note(LABEL[k], v, `outside ${lo}–${hi}`, r); return NaN; }
      return v;
    });
  }
  // stuck temperature / RH
  for (const k of ["temperature", "relative_humidity"]) {
    const v = fin(series[k]);
    if (v.length >= STUCK_HOURS && v.every((x) => x === v[0])) {
      note(LABEL[k], v[0], `stuck at the same value for ${v.length} hours`);
      series[k] = series[k].map(() => NaN);
    }
  }
  // spikes in temperature, RH, sustained wind
  for (const [k, jump] of Object.entries(SPIKE)) {
    const s = series[k], out = [...s];
    for (let i = 0; i < s.length; i++) {
      const prev = s.slice(0, i).reverse().find(Number.isFinite), next = s.slice(i + 1).find(Number.isFinite);
      if (!Number.isFinite(s[i]) || !Number.isFinite(prev) || !Number.isFinite(next)) continue;
      if (Math.abs(s[i] - prev) > jump && Math.abs(s[i] - next) > jump && Math.abs(prev - next) < jump / 2 && Math.sign(s[i] - prev) === Math.sign(s[i] - next)) {
        note(LABEL[k], s[i], `spike: ${prev} the hour before, ${next} the hour after`, rows[i]);
        out[i] = NaN;
      }
    }
    series[k] = out;
  }
  // gusts: lower than the wind is a sensor error; odd-looking high gusts need backing up
  const d = { rows, series, rawGust: [...series.peak_gust_speed], issues, pending: [], hourNum: rows.map((r) => hourNumber(r)) };
  const G = series.peak_gust_speed;
  for (let i = 0; i < G.length; i++) {
    const g = G[i], w = series.wind_speed[i];
    if (!Number.isFinite(g)) continue;
    if (Number.isFinite(w) && g + 2 < w) { note("gust", g, `lower than the sustained wind (${w} mph)`, rows[i]); G[i] = NaN; d.rawGust[i] = NaN; continue; }
    const prev = d.rawGust.slice(0, i).reverse().find(Number.isFinite), next = d.rawGust.slice(i + 1).find(Number.isFinite);
    let odd = "";
    if (g > SUSPECT_GUST) odd = `over ${SUSPECT_GUST} mph`;
    else if (Number.isFinite(w) && g > GUST.factor * w + GUST.plus) odd = `far above the sustained wind (${w} mph)`;
    else if (Number.isFinite(prev) && Number.isFinite(next) && g - prev > GUST.spike && g - next > GUST.spike) odd = `jump from ${prev} and back to ${next}`;
    if (!odd) continue;
    const why = ownSupport(d, i);
    if (why) { note("gust", g, `${odd}, but backed up: ${why}`, rows[i], "kept – wind event"); continue; }
    G[i] = NaN; // held back until neighbours are checked
    d.pending.push({ i, value: g, issue: note("gust", g, `${odd}; nothing else backs it up`, rows[i]) });
  }
  return summarize(d);
}

function summarize(d) {
  const S = d.series;
  const t = fin(S.temperature), rh = fin(S.relative_humidity), g = fin(S.peak_gust_speed), w = fin(S.wind_speed), p = fin(S.hourly_precip);
  let precip = p.length ? p.reduce((a, b) => a + b, 0) : NaN;
  if (precip > MAX_DAILY_PRECIP && !d.precipChecked) {
    d.issues.push({ field: "rain", value: Math.round(precip * 100) / 100, reason: `24-h total over ${MAX_DAILY_PRECIP} in. (gauge reset?)`, hour: "", action: "dropped" });
    S.hourly_precip = S.hourly_precip.map(() => NaN); precip = NaN;
  }
  d.precipChecked = true;
  return Object.assign(d, {
    hours: d.rows.length,
    maxTemp: t.length ? Math.max(...t) : NaN,
    minRh: rh.length ? Math.min(...rh) : NaN,
    maxGust: g.length ? Math.max(...g) : w.length ? Math.max(...w) : NaN,
    precip,
  });
}

/* days: checkStationDay() results for one PSA (with id, name added); changes them in place.
   opts.windEvent: true when the day/PSA is listed as a known wind event in js/config.js. */
function checkNeighbours(days, opts = {}) {
  // another station's gust within 2 hours that is strong enough to back up a gust of v mph
  const nearbyGust = (d, i, v) => {
    const h = d.hourNum ? d.hourNum[i] : NaN, need = nearbyNeeded(v);
    let best = null;
    for (const o of days) {
      if (o === d || !o.series) continue;
      o.series.peak_gust_speed.forEach((og, j) => {
        if (!Number.isFinite(og) || og < need) return;
        const oh = o.hourNum ? o.hourNum[j] : NaN;
        const close = Number.isFinite(h) && Number.isFinite(oh) ? Math.abs(oh - h) <= WIND_EVENT.nearbyHours : Math.abs(j - i) <= WIND_EVENT.nearbyHours;
        if (close && (!best || og > best.og)) best = { og, who: o.name || o.id };
      });
    }
    return best ? `${best.og} mph at ${best.who}` : "";
  };
  // restore held-back gusts that another station backs up at a similar strength
  for (const d of days) {
    for (const p of d.pending || []) {
      const near = nearbyGust(d, p.i, p.value);
      const why = opts.windEvent ? "listed as a wind event in js/config.js" : near ? `also gusty nearby: ${near}` : "";
      if (why && p.value <= LIMITS.peak_gust_speed[1]) {
        d.series.peak_gust_speed[p.i] = p.value;
        p.issue.action = "kept – wind event";
        p.issue.reason = p.issue.reason.replace("; nothing else backs it up", `, but backed up: ${why}`);
      } else if (!near) {
        p.issue.reason = p.issue.reason.replace("; nothing else backs it up", `; no station nearby gusted ${Math.round(nearbyNeeded(p.value))}+ mph`);
      }
    }
    if (d.series) summarize(d);
  }
  // a station's max gust far above every other station in the PSA (checked during wind events too)
  for (const d of days) {
    if (!Number.isFinite(d.maxGust) || opts.windEvent) continue;
    const others = fin(days.filter((o) => o !== d).map((o) => o.maxGust));
    if (others.length < 2) continue;
    const m = median(others), top = Math.max(...others);
    if (d.maxGust - m <= NEIGHBOUR.maxGust || top >= nearbyNeeded(d.maxGust)) continue;
    if (!d.series) { // daily summary only
      d.issues.push({ field: "max gust", value: d.maxGust, reason: `${Math.round(d.maxGust - m)} mph above the other stations' median (${Math.round(m)}); highest elsewhere ${top} mph`, hour: "", action: "dropped" });
      d.maxGust = NaN; continue;
    }
    // drop the station's high gusts one at a time until what's left is backed up
    for (;;) {
      const G = d.series.peak_gust_speed, g = Math.max(...fin(G));
      if (!Number.isFinite(g) || g - m <= NEIGHBOUR.maxGust) break;
      const i = G.indexOf(g);
      const why = ownSupport(d, i, g) || nearbyGust(d, i, g);
      if (why) {
        d.issues.push({ field: "max gust", value: g, reason: `${Math.round(g - m)} mph above the other stations, but backed up: ${why}`, hour: d.rows[i] ? hourOf(d.rows[i]) : "", action: "kept – wind event" });
        break;
      }
      d.issues.push({ field: "gust", value: g, reason: `${Math.round(g - m)} mph above the other stations' median (${Math.round(m)}); highest elsewhere ${top} mph`, hour: d.rows[i] ? hourOf(d.rows[i]) : "", action: "dropped" });
      G[i] = NaN;
    }
    summarize(d);
  }
  // temperature and RH far from the rest of the PSA
  for (const [k, gap] of Object.entries(NEIGHBOUR)) {
    if (k === "maxGust") continue;
    for (const d of days) {
      const others = fin(days.filter((o) => o !== d).map((o) => o[k]));
      if (others.length < 2 || !Number.isFinite(d[k])) continue;
      const m = median(others);
      if (Math.abs(d[k] - m) <= gap) continue;
      const label = { maxTemp: "max temperature", minRh: "min RH" }[k];
      d.issues.push({ field: label, value: d[k], reason: `${Math.round(Math.abs(d[k] - m))} away from the other stations' median (${Math.round(m)})`, hour: "", action: "dropped" });
      d[k] = NaN;
    }
  }
  for (const d of days) {
    const others = fin(days.filter((o) => o !== d).map((o) => o.precip));
    if (others.length >= 2 && d.precip >= 1 && others.every((v) => v < 0.05)) {
      d.issues.push({ field: "rain", value: Math.round(d.precip * 100) / 100, reason: "heavy rain here while the other stations in the PSA were dry", hour: "", action: "kept, check" });
    }
  }
  // wind event: counted from the gusts that survived the checks
  const windyStations = days.filter((d) => fin(d.series ? d.series.peak_gust_speed : [d.maxGust]).some((g) => g >= WIND_EVENT.gust)).length;
  days.windEvent = Boolean(opts.windEvent) || windyStations >= 2 || (days.length >= 4 && windyStations / days.length >= 0.25);
  days.windyStations = windyStations;
  return days;
}

module.exports = { checkStationDay, checkNeighbours, ownSupport, nearbyNeeded, LIMITS, SPIKE, GUST, WIND_EVENT, SUSPECT_GUST, EXTREME_GUST, BACKING, NEIGHBOUR, MAX_DAILY_PRECIP };
