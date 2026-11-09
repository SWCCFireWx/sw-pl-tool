// Daily archive: a JSON snapshot of every run plus CSV tables that build up into a database
// for checking the PL model against what actually happened.
//
//   data/archive/history.csv            one row per run: PL, score, each element's rating and inputs
//   data/archive/fire_starts_daily.csv  one row per day: new starts by cause, acres, starts per PSA
//   data/archive/fire_starts.csv        one row per fire (id, date, cause, acres, PSA, location)
//   data/archive/raws_daily.csv         one row per day and PSA: RAWS max temp, min RH, max gust, precip
//   data/archive/raws_checks.csv        every RAWS reading the quality checks removed or flagged, and why
//   data/archive/fems_erc_bi_daily.csv  one row per day and PSA: FEMS fuel model Y ERC and BI (13:00 and daily max)
//   data/archive/fems_erc_bi_stations.csv  the same per station (SWCC ERC station list, including "Other")
//   data/archive/snapshots/YYYY/YYYY-MM-DD_HHMM.json   the full data behind each run's PL
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------- CSV ---------- */
const q = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function parseCsv(text) {
  const rows = []; let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') inQ = false; else cur += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}
function readTable(file) {
  if (!fs.existsSync(file)) return [];
  const [head, ...rows] = parseCsv(fs.readFileSync(file, "utf8"));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}
function writeTable(file, columns, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const extra = [...new Set(records.flatMap((r) => Object.keys(r)))].filter((k) => !columns.includes(k));
  const cols = [...columns, ...extra];
  fs.writeFileSync(file, [cols.join(","), ...records.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n");
}
/* Replace rows with the same key, add new ones, keep the rest; sorted by key. */
function upsert(file, columns, keyOf, records, sortOf = keyOf) {
  const map = new Map(readTable(file).map((r) => [keyOf(r), r]));
  for (const r of records) map.set(keyOf(r), r);
  const all = [...map.values()].sort((a, b) => sortOf(a).localeCompare(sortOf(b)));
  writeTable(file, columns, all);
  return all.length;
}

/* ---------- columns ---------- */
const HISTORY_COLS = ["run_time", "run_date", "run_slot", "pl", "score", "weights",
  "w_fire", "w_imt", "w_crews", "w_outlook", "w_danger",
  "fire_rating", "fire_complex", "fire_t3", "fire_contribution",
  "imt_rating", "imt_cimt_available", "imt_t3_available", "imt_cimt_committed", "imt_contribution", "imts_sheet_update",
  "crews_rating", "crews_available", "crews_swa_total", "crews_ratio", "crews_committed", "crews_contribution", "crews_sheet_update",
  "outlook_rating", "outlook_avg", "outlook_day1_score", "outlook_day1", "outlook_high_risk_psa_days", "outlook_contribution",
  "danger_rating", "erc_date", "erc_p97plus", "erc_p90_96", "erc_p50_89", "erc_below50", "erc_max_pct", "erc_source", "danger_contribution",
  "starts_date", "starts_total", "starts_lightning", "starts_human", "starts_unknown", "starts_acres",
  "fems_date", "fems_erc_avg", "fems_bi_avg", "fems_erc_highest_psa", "fems_bi_highest_psa",
  "raws_date", "raws_stations", "raws_readings_dropped", "raws_avg_max_temp", "raws_avg_min_rh", "raws_lowest_rh", "raws_max_gust", "raws_wetting_rain_stations",
  "snapshot"];
const DAILY_COLS = ["date", "total", "lightning", "human", "unknown", "acres", "placed_by_psa", "updated"];
const FIRE_COLS = ["id", "date", "time", "name", "cause", "cause_reported", "acres", "state", "dispatch", "psa", "lat", "lon", "updated"];
const NFDR_COLS = ["date", "psa", "fuel_model", "stations", "stations_listed", "erc_1300", "bi_1300", "erc_daily_max", "bi_daily_max"];
const RAWS_COLS = ["date", "psa", "stations", "avg_max_temp_f", "avg_min_rh", "lowest_rh", "max_gust_mph", "avg_precip_in", "wetting_rain_stations", "wind_event", "stations_gust_40_plus", "readings_removed"];

function historyRow(state, r, runTime, snapshotRel, C) {
  const el = Object.fromEntries(r.elements.map((e) => [e.key, e]));
  const ercPcts = Object.values(state.danger.rows || {}).map((x) => parseFloat(x.ercPct)).filter(Number.isFinite);
  const fs1 = state.fireStarts || {}, y = (fs1.daily || {})[fs1.to] || {};
  const rw = state.raws || {}, rb = Object.values(rw.byPsa || {});
  const nf = state.femsNfdr || {}, nb = Object.values(nf.byPsa || {}).filter((x) => x.stations);
  const nAvg = (k) => { const v = nb.map((x) => parseFloat(x[k])).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : ""; };
  const nMax = (k) => { const v = nb.map((x) => parseFloat(x[k])).filter(Number.isFinite); return v.length ? Math.max(...v) : ""; };
  const avgOf = (k) => { const v = rb.map((x) => parseFloat(x[k])).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : ""; };
  const listOf = (k) => rb.map((x) => parseFloat(x[k])).filter(Number.isFinite);
  const hour = parseInt(runTime.slice(11, 13), 10);
  return {
    run_time: runTime, run_date: runTime.slice(0, 10), run_slot: hour < 12 ? "AM" : "PM", pl: r.pl, score: r.score, weights: state.preset,
    w_fire: el.fire.weight, w_imt: el.imt.weight, w_crews: el.crews.weight, w_outlook: el.outlook.weight, w_danger: el.danger.weight,
    fire_rating: r.fire.rating, fire_complex: r.fire.complex, fire_t3: r.fire.t3, fire_contribution: el.fire.contribution,
    imt_rating: r.imt.rating, imt_cimt_available: r.imt.availCimt, imt_t3_available: r.imt.availT3, imt_cimt_committed: r.imt.commCimt,
    imt_contribution: el.imt.contribution, imts_sheet_update: (state.imtsSource || {}).lastUpdate || "",
    crews_rating: r.crews.rating, crews_available: r.crews.totalAvail, crews_swa_total: r.crews.swaTotal,
    crews_ratio: Math.round(r.crews.ratio * 1000) / 1000, crews_committed: r.crews.swa.committed, crews_contribution: el.crews.contribution,
    crews_sheet_update: (state.crewsSource || {}).lastUpdate || "",
    outlook_rating: r.outlook.rating, outlook_avg: r.outlook.avg, outlook_day1_score: r.outlook.daily[0].score,
    outlook_day1: state.outlook.startDate, outlook_high_risk_psa_days: r.outlook.daily.reduce((a, d) => a + d.counts[4], 0),
    outlook_contribution: el.outlook.contribution,
    danger_rating: r.danger.rating, erc_date: state.danger.date, erc_p97plus: r.danger.bins.p97plus, erc_p90_96: r.danger.bins.p90to96,
    erc_p50_89: r.danger.bins.p50to89, erc_below50: r.danger.bins.below50, erc_max_pct: ercPcts.length ? Math.max(...ercPcts) : "",
    erc_source: state.danger.source || "", danger_contribution: el.danger.contribution,
    starts_date: fs1.to || "", starts_total: y.total ?? "", starts_lightning: y.lightning ?? "", starts_human: y.human ?? "",
    starts_unknown: y.unknown ?? "", starts_acres: y.acres ?? "",
    fems_date: nf.date || "", fems_erc_avg: nAvg("erc"), fems_bi_avg: nAvg("bi"), fems_erc_highest_psa: nMax("erc"), fems_bi_highest_psa: nMax("bi"),
    raws_date: rw.date || "", raws_stations: rb.reduce((a, x) => a + (x.stations || 0), 0) || "",
    raws_readings_dropped: rb.length ? rb.reduce((a, x) => a + (x.readingsDropped || 0), 0) : "",
    raws_avg_max_temp: avgOf("avgMaxTemp"), raws_avg_min_rh: avgOf("avgMinRh"),
    raws_lowest_rh: listOf("lowestRh").length ? Math.min(...listOf("lowestRh")) : "",
    raws_max_gust: listOf("maxGust").length ? Math.max(...listOf("maxGust")) : "",
    raws_wetting_rain_stations: rb.length ? rb.reduce((a, x) => a + (x.wettingRain || 0), 0) : "",
    snapshot: snapshotRel,
  };
}

/* Writes everything for one run. Returns a short summary. */
function archiveRun({ root, state, result, runTime, C }) {
  const dir = path.join(root, "data", "archive");
  const snapRel = `data/archive/snapshots/${runTime.slice(0, 4)}/${runTime.slice(0, 10)}_${runTime.slice(11, 13)}${runTime.slice(14, 16)}.json`;
  fs.mkdirSync(path.dirname(path.join(root, snapRel)), { recursive: true });
  fs.writeFileSync(path.join(root, snapRel), JSON.stringify({ runTime, pl: result.pl, score: result.score, state }));

  const runs = upsert(path.join(dir, "history.csv"), HISTORY_COLS, (r) => r.run_time, [historyRow(state, result, runTime, snapRel, C)]);

  let days = 0, fires = 0, raws = 0;
  const f = state.fireStarts;
  if (f && f.daily) {
    const psaCols = C.psas.map((p) => `psa_${p.ercId}`);
    const rows = Object.entries(f.daily).map(([date, s]) => ({
      date, total: s.total, lightning: s.lightning, human: s.human, unknown: s.unknown, acres: s.acres,
      placed_by_psa: f.placedByPsa ? "yes" : "no", updated: runTime,
      ...Object.fromEntries(C.psas.map((p) => [`psa_${p.ercId}`, (s.byPsa[p.ercId] || {}).total || 0])),
    }));
    days = upsert(path.join(dir, "fire_starts_daily.csv"), [...DAILY_COLS, ...psaCols], (r) => r.date, rows);
    fires = upsert(path.join(dir, "fire_starts.csv"), FIRE_COLS, (r) => r.id,
      (f.fires || []).map(({ causeRaw, ...x }) => ({ ...x, cause_reported: causeRaw, updated: runTime })), (r) => `${r.date} ${r.time} ${r.id}`);
  }
  const w = state.raws;
  if (w && w.byPsa) {
    raws = upsert(path.join(dir, "raws_daily.csv"), RAWS_COLS, (r) => `${r.date}|${r.psa}`,
      Object.entries(w.byPsa).map(([psa, x]) => ({ date: w.date, psa, stations: x.stations, avg_max_temp_f: x.avgMaxTemp, avg_min_rh: x.avgMinRh,
        lowest_rh: x.lowestRh, max_gust_mph: x.maxGust, avg_precip_in: x.avgPrecip, wetting_rain_stations: x.wettingRain,
        wind_event: x.windEvent ? "yes" : "no", stations_gust_40_plus: x.windyStations ?? "", readings_removed: x.readingsDropped ?? "" })));
  }
  if (w && Array.isArray(w.checks)) {
    // replace that day's rows so a re-run doesn't duplicate them
    const file = path.join(dir, "raws_checks.csv");
    const keep = readTable(file).filter((r) => r.date !== w.date);
    writeTable(file, ["date", "psa", "station_id", "station", "field", "hour", "value", "reason", "action"],
      [...keep, ...w.checks.map((c) => ({ date: w.date, psa: c.psa, station_id: c.id, station: c.name, field: c.field, hour: c.hour, value: c.value, reason: c.reason, action: c.action }))]);
  }
  let nfdr = 0;
  const n = state.femsNfdr;
  if (n && n.byPsa) {
    nfdr = upsert(path.join(dir, "fems_erc_bi_daily.csv"), NFDR_COLS, (r) => `${r.date}|${r.psa}`,
      Object.entries(n.byPsa).map(([psa, x]) => ({ date: n.date, psa, fuel_model: n.fuelModel, stations: x.stations, stations_listed: x.stationsListed,
        erc_1300: x.erc, bi_1300: x.bi, erc_daily_max: x.ercMax, bi_daily_max: x.biMax })));
    upsert(path.join(dir, "fems_erc_bi_stations.csv"), ["date", "psa", "station_id", "station", "obs_hour", "erc_1300", "bi_1300", "erc_daily_max", "bi_daily_max"],
      (r) => `${r.date}|${r.psa}|${r.station_id}`,
      (n.stations || []).map((x) => ({ date: n.date, psa: x.psa, station_id: x.id, station: x.name, obs_hour: x.hour, erc_1300: x.erc, bi_1300: x.bi, erc_daily_max: x.ercMax, bi_daily_max: x.biMax })));
  }
  return { snapshot: snapRel, runs, days, fires, raws, nfdr };
}

module.exports = { archiveRun, historyRow, parseCsv, readTable, writeTable, upsert, HISTORY_COLS };
