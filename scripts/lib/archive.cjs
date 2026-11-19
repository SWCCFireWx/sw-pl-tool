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
//   data/archive/raws_stations_daily.csv  one row per day and station (RAWS and ASOS/AWOS) after the checks
//   data/archive/outlook_psa_daily.csv  one row per 7-Day issue date and PSA: the Day 1–7 levels
//   data/archive/ercy_psa_daily.csv     one row per ERC/BI date and PSA: ERCy and BIy value and percentile
//   data/archive/ercy_stations_daily.csv  one row per ERC/BI date, PSA and FEMS station: the station's ERC and BI
//   data/archive/snapshots/YYYY/YYYY-MM-DD_HHMM.json   the full data behind each run's PL
// Nothing is ever deleted: rows are only added or replaced by key, and every snapshot is kept.
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
const HISTORY_COLS = ["run_time", "run_date", "run_slot", "pl", "score", "weights", "pl_from_score", "pl_held_no_fire",
  "pl_calculated", "pl_confirmed", "pl_pending", "run_trigger", "criteria_version", "criteria_fingerprint",
  "model_pl", "model_score", "model_held", "model_fire_rating",
  "old_shoulder_pl", "old_shoulder_score", "old_season_pl", "old_season_score",
  "w_fire", "w_imt", "w_crews", "w_outlook", "w_danger",
  "fire_rating", "fire_mode", "fire_complex", "fire_t3", "fire_contribution",
  "fire_large_rating", "fire_starts_avg3", "fire_escapes", "fire_ia_rating", "fire_demand", "fire_capacity_step", "fire_outlook_step",
  "imt_rating", "imt_cimt_available", "imt_t3_available", "imt_cimt_committed", "imt_contribution", "imts_sheet_update",
  "crews_rating", "crews_available", "crews_swa_total", "crews_ratio", "crews_committed", "crews_contribution", "crews_sheet_update",
  "imt_cimt_committed_sw", "imt_t3_committed_sw", "imt_committed_out_of_area", "imt_committed_no_location",
  "crews_committed_sw", "crews_committed_out_of_area", "crews_in_southwest", "crews_committed_sw_share",
  "t2ia_counted", "crews_t2ia_total", "crews_t2ia_available", "crews_ratio_with_t2ia", "crews_rating_with_t2ia", "crews_ratio_without_t2ia", "crews_rating_without_t2ia",
  "pl_with_t2ia", "score_with_t2ia", "pl_without_t2ia", "score_without_t2ia", "actual_pl", "actual_pl_source", "forecast_pl_d1", "forecast_pl_d2", "forecast_pl_d3", "forecast_pl_d4", "forecast_pl_d5", "forecast_pl_d6",
  "outlook_rating", "outlook_avg", "outlook_days13_avg", "outlook_days47_avg", "outlook_day1_score", "outlook_day1", "outlook_high_risk_psa_days", "outlook_contribution",
  "danger_rating", "erc_date", "erc_p97plus", "erc_p90_96", "erc_p50_89", "erc_below50", "erc_max_pct", "erc_source", "danger_contribution",
  "starts_date", "starts_total", "starts_lightning", "starts_human", "starts_unknown", "starts_acres",
  "fems_date", "fems_erc_avg", "fems_bi_avg", "fems_erc_highest_psa", "fems_bi_highest_psa",
  "raws_date", "raws_stations", "raws_readings_dropped", "raws_avg_max_temp", "raws_avg_min_rh", "raws_lowest_rh", "raws_max_gust", "raws_wetting_rain_stations",
  "snapshot"];
const DAILY_COLS = ["date", "total", "lightning", "human", "unknown", "acres", "placed_by_psa", "updated"];
const FIRE_COLS = ["id", "date", "time", "name", "cause", "cause_reported", "acres", "state", "dispatch", "psa", "lat", "lon", "updated"];
const STATION_COLS = ["date", "psa", "network", "station_id", "station", "hours", "max_temp_f", "min_rh", "max_gust_mph", "precip_in", "checks", "updated"];
const CHECK_COLS = ["date", "psa", "network", "station_id", "station", "field", "hour", "value", "reason", "action"];
const OUTLOOK_COLS = ["date", "psa", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "source"];
const ERCY_COLS = ["date", "psa", "erc_val", "erc_pct", "bi_val", "bi_pct", "stations", "stations_listed", "not_reported", "source"];
const ERCY_STATION_COLS = ["date", "psa", "station_id", "station", "erc", "bi", "reported", "source"];
const NFDR_COLS = ["date", "psa", "fuel_model", "stations", "stations_listed", "erc_1300", "bi_1300", "erc_daily_max", "bi_daily_max"];
const RAWS_COLS = ["date", "psa", "stations", "raws_stations", "asos_stations", "avg_max_temp_f", "avg_min_rh", "lowest_rh", "max_gust_mph", "avg_precip_in", "wetting_rain_stations", "wind_event", "stations_gust_40_plus", "readings_removed"];

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
    pl_from_score: r.scorePl ?? r.pl, pl_held_no_fire: r.held ? "yes" : "no",
    pl_calculated: r.plCalculated ?? r.pl, pl_confirmed: (state.plConfirm || {}).pl ?? "", pl_pending: ((state.plConfirm || {}).pending || {}).pl ?? "",
    run_trigger: (state.health || {}).trigger || "", criteria_version: (r.criteria || {}).label ?? "", criteria_fingerprint: (r.criteria || {}).fingerprint ?? "",
    old_shoulder_pl: (r.compare || {}).shoulder?.pl ?? "", old_shoulder_score: (r.compare || {}).shoulder?.score ?? "",
    old_season_pl: (r.compare || {}).season?.pl ?? "", old_season_score: (r.compare || {}).season?.score ?? "",
    fire_mode: r.fire.mode || "", fire_large_rating: r.fire.large || "", fire_starts_avg3: r.fire.startsAvg ?? "",
    fire_escapes: r.fire.escapes ?? "", fire_ia_rating: r.fire.ia || "", fire_demand: r.fire.demand || "",
    fire_capacity_step: (r.fire.steps || []).some((x) => x.kind === "capacity") ? "yes" : "no",
    fire_outlook_step: (r.fire.steps || []).some((x) => x.kind === "outlook") ? "yes" : "no",
    fire_rating: r.fire.rating, fire_complex: r.fire.complex, fire_t3: r.fire.t3, fire_contribution: el.fire.contribution,
    imt_rating: r.imt.rating, imt_cimt_available: r.imt.availCimt, imt_t3_available: r.imt.availT3, imt_cimt_committed: r.imt.commCimt,
    imt_contribution: el.imt.contribution, imts_sheet_update: (state.imtsSource || {}).lastUpdate || "",
    crews_rating: r.crews.rating, crews_available: r.crews.totalAvail, crews_swa_total: r.crews.swaTotal,
    crews_ratio: Math.round(r.crews.ratio * 1000) / 1000, crews_committed: r.crews.swa.committed, crews_contribution: el.crews.contribution,
    imt_cimt_committed_sw: r.imt.commCimtSw ?? "", imt_t3_committed_sw: r.imt.commT3Sw ?? "", imt_committed_out_of_area: r.imt.commOut ?? "", imt_committed_no_location: r.imt.commNoLocation ?? "",
    crews_committed_sw: r.crews.committedSw ?? "", crews_committed_out_of_area: r.crews.committedOut ?? "", crews_in_southwest: r.crews.pool ?? "",
    crews_committed_sw_share: r.crews.committedSwShare === undefined ? "" : Math.round(r.crews.committedSwShare * 1000) / 1000,
    t2ia_counted: r.crews.includeT2IA ? "yes" : "no", crews_t2ia_total: r.crews.t2iaTotal ?? "", crews_t2ia_available: r.crews.t2iaAvail ?? "",
    ...(r.alt ? {
      crews_ratio_with_t2ia: Math.round(r.alt.with.crews.ratio * 1000) / 1000, crews_rating_with_t2ia: r.alt.with.crews.rating,
      crews_ratio_without_t2ia: Math.round(r.alt.without.crews.ratio * 1000) / 1000, crews_rating_without_t2ia: r.alt.without.crews.rating,
      pl_with_t2ia: r.alt.with.pl, score_with_t2ia: r.alt.with.score, pl_without_t2ia: r.alt.without.pl, score_without_t2ia: r.alt.without.score } : {}),
    actual_pl: (state.actualPl || {}).pl ?? "", actual_pl_source: (state.actualPl || {}).source ?? "",
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [`forecast_pl_d${k}`, ((((state.forecast || {}).days) || [])[k] || {}).pl ?? ""])),
    crews_sheet_update: (state.crewsSource || {}).lastUpdate || "",
    outlook_rating: r.outlook.rating, outlook_avg: r.outlook.avg,
    outlook_days13_avg: r.outlook.daily.length === 7 ? Math.round(r.outlook.daily.slice(0, 3).reduce((a, d) => a + d.score, 0) / 3 * 100) / 100 : "",
    outlook_days47_avg: r.outlook.daily.length === 7 ? Math.round(r.outlook.daily.slice(3).reduce((a, d) => a + d.score, 0) / 4 * 100) / 100 : "",
    model_pl: (r.model || r).pl, model_score: (r.model || r).score, model_held: (r.model || r).held ? "yes" : "no", model_fire_rating: (r.model || r).fire.rating, outlook_day1_score: r.outlook.daily[0].score,
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

/* One day of RAWS + ASOS/AWOS summaries (fetchRaws result) → raws_daily.csv, raws_stations_daily.csv,
   raws_checks.csv. Re-writing a day replaces its rows, so re-checked days don't duplicate. Returns raws_daily rows. */
function writeRaws(dir, w, runTime) {
  if (!w || !w.byPsa) return 0;
  fs.mkdirSync(dir, { recursive: true });
  const n = upsert(path.join(dir, "raws_daily.csv"), RAWS_COLS, (r) => `${r.date}|${r.psa}`,
    Object.entries(w.byPsa).map(([psa, x]) => ({ date: w.date, psa, stations: x.stations, raws_stations: x.rawsStations ?? x.stations, asos_stations: x.asosStations ?? 0,
      avg_max_temp_f: x.avgMaxTemp, avg_min_rh: x.avgMinRh,
      lowest_rh: x.lowestRh, max_gust_mph: x.maxGust, avg_precip_in: x.avgPrecip, wetting_rain_stations: x.wettingRain,
      wind_event: x.windEvent ? "yes" : "no", stations_gust_40_plus: x.windyStations ?? "", readings_removed: x.readingsDropped ?? "" })));
  if (Array.isArray(w.stations)) {
    const file = path.join(dir, "raws_stations_daily.csv");
    const keep = readTable(file).filter((r) => r.date !== w.date);
    writeTable(file, STATION_COLS, [...keep, ...w.stations.map((x) => ({ date: w.date, psa: x.psa, network: x.network || "RAWS", station_id: x.id, station: x.name,
      hours: x.hours ?? "", max_temp_f: x.maxTemp, min_rh: x.minRh, max_gust_mph: x.maxGust, precip_in: x.precip, checks: x.issues ?? "", updated: runTime }))]
      .sort((a, b) => `${a.date}|${a.psa}|${a.station}`.localeCompare(`${b.date}|${b.psa}|${b.station}`)));
  }
  if (Array.isArray(w.checks)) {
    const file = path.join(dir, "raws_checks.csv");
    const keep = readTable(file).filter((r) => r.date !== w.date);
    writeTable(file, CHECK_COLS, [...keep, ...w.checks.map((c) => ({ date: w.date, psa: c.psa, network: c.network || "RAWS", station_id: c.id, station: c.name,
      field: c.field, hour: c.hour, value: c.value, reason: c.reason, action: c.action }))].sort((a, b) => a.date.localeCompare(b.date)));
  }
  return n;
}

/* The 7-Day levels per PSA (keyed by issue date) and the uploaded ERCy/BIy per PSA (keyed by its date). */
function writeOutlookErcy(dir, state, C) {
  let o = 0, e = 0;
  const out = state.outlook;
  if (out && out.startDate && out.values) {
    o = upsert(path.join(dir, "outlook_psa_daily.csv"), OUTLOOK_COLS, (r) => `${r.date}|${r.psa}`,
      C.psas.filter((p) => out.values[p.id]).map((p) => ({ date: out.startDate, psa: p.ercId, ...Object.fromEntries(out.values[p.id].map((v, i) => [`d${i + 1}`, v])), source: out.source || "" })));
  }
  const dg = state.danger;
  if (dg && dg.date && dg.rows && Object.values(dg.rows).some((x) => x.ercPct !== "" && x.ercPct !== undefined)) {
    e = upsert(path.join(dir, "ercy_psa_daily.csv"), ERCY_COLS, (r) => `${r.date}|${r.psa}`,
      C.psas.map((p) => { const x = dg.rows[p.ercId] || {}; return { date: dg.date, psa: p.ercId, erc_val: x.ercVal ?? "", erc_pct: x.ercPct ?? "", bi_val: x.biVal ?? "", bi_pct: x.biPct ?? "",
        stations: x.stations ?? "", stations_listed: x.stationsListed ?? "", not_reported: (x.missing || []).join("; "), source: dg.source || "" }; }));
    if (Array.isArray(dg.stations) && dg.stations.length) {
      upsert(path.join(dir, "ercy_stations_daily.csv"), ERCY_STATION_COLS, (r) => `${r.date}|${r.psa}|${r.station_id}`,
        dg.stations.map((x) => ({ date: dg.date, psa: x.psa, station_id: x.id, station: x.name, erc: x.erc ?? "", bi: x.bi ?? "", reported: x.reported ? "yes" : "no", source: dg.source || "" })));
    }
  }
  return { outlook: o, ercy: e };
}

/* PL forecasts (one row per run and lead day) and the actual PL (one row per day, latest check wins). */
const FORECAST_COLS = ["issued", "issued_date", "lead_days", "target_date", "outlook_issued", "outlook_day", "criteria_version", "criteria_fingerprint", "pl", "score", "pl_held_no_fire", "fire", "imt", "crews", "outlook", "danger", "outlook_avg", "erc_bi_source"];
const ACTUAL_COLS = ["date", "pl", "source", "as_of", "checked"];
function writeForecastActual(dir, state, runTime) {
  const f = state.forecast;
  if (f && Array.isArray(f.days) && f.days.length) {
    upsert(path.join(dir, "forecast_pl.csv"), FORECAST_COLS, (r) => `${r.issued}|${r.lead_days}`,
      f.days.map((d) => ({ issued: runTime, issued_date: runTime.slice(0, 10), lead_days: d.lead, target_date: d.date, outlook_issued: d.outlookIssued || "", outlook_day: d.outlookDay ?? "",
        criteria_version: (f.criteria || {}).label ?? "", criteria_fingerprint: (f.criteria || {}).fingerprint ?? "", pl: d.pl, score: d.score, pl_held_no_fire: d.held ? "yes" : "no",
        fire: d.ratings.fire, imt: d.ratings.imt, crews: d.ratings.crews, outlook: d.ratings.outlook, danger: d.ratings.danger, outlook_avg: d.outlookAvg, erc_bi_source: d.dangerSource })),
      (r) => `${r.issued}|${String(r.lead_days).padStart(2, "0")}`);
  }
  const a = state.actualPl;
  if (a && a.pl) upsert(path.join(dir, "actual_pl.csv"), ACTUAL_COLS, (r) => r.date, [{ date: a.date, pl: a.pl, source: a.source, as_of: a.asOf || "", checked: a.checkedAt || runTime }]);
  // Official PL next to this tool's, every day; days that differ get a reason in decisions/pl_reasons.csv
  const pc = state.plConfirm;
  if (a && a.pl && pc && pc.pl && a.date === runTime.slice(0, 10)) {
    upsert(path.join(dir, "pl_compare.csv"), ["date", "official_pl", "tool_pl", "tool_calculated", "differs", "official_source", "criteria_version"], (r) => r.date,
      [{ date: a.date, official_pl: a.pl, tool_pl: pc.pl, tool_calculated: pc.calculated ?? "", differs: +a.pl !== +pc.pl ? "yes" : "no", official_source: a.source, criteria_version: (state.criteria || {}).label || "" }]);
  }
}
/* Every crew and IMT with its status, once per run. */
const CREW_DAILY_COLS = ["run_time", "date", "list", "crew", "type", "status", "location", "incident", "home_state", "home_dispatch", "home_unit", "day_off", "date_committed", "remarks", "sheet_update"];
const IMT_DAILY_COLS = ["run_time", "date", "team", "type", "zone", "incident_commander", "home", "status", "incident", "date_committed", "remarks", "sheet_update"];
function writeCrewsImts(dir, state, runTime) {
  const lists = [["SWA Type 1 IHC", state.crews], ["OOA Type 1 IHC", state.ooaCrews], ["SWA Type 2IA", state.t2iaCrews]];
  const src = state.crewsSource || {};
  const crewRows = lists.flatMap(([list, arr]) => (arr || []).filter((c) => c && c.name).map((c) => ({ run_time: runTime, date: runTime.slice(0, 10), list, crew: c.name, type: c.type || "",
    status: c.status || "", location: c.location || "", incident: c.incident || "", home_state: c.state || "", home_dispatch: c.disp || "", home_unit: c.unit || "",
    day_off: c.dayOff || "", date_committed: c.dateCom || "", remarks: c.remarks || "", sheet_update: list.startsWith("OOA") ? src.ooaLastUpdate || "" : list.includes("2IA") ? src.t2iaLastUpdate || "" : src.lastUpdate || "" })));
  if (crewRows.length) upsert(path.join(dir, "crews_daily.csv"), CREW_DAILY_COLS, (r) => `${r.run_time}|${r.list}|${r.crew}`, crewRows, (r) => `${r.run_time}|${r.list}|${r.crew}`);
  const isrc = state.imtsSource || {};
  const imtRows = (state.imts || []).filter((t) => t && (t.ic || t.zone)).map((t) => ({ run_time: runTime, date: runTime.slice(0, 10), team: t.zone || t.mob || "", type: t.type || "", zone: t.zone || "",
    incident_commander: t.ic || "", home: t.home || "", status: t.status || "", incident: t.incident || "", date_committed: t.dateComm || "", remarks: t.remarks || "", sheet_update: isrc.lastUpdate || "" }));
  if (imtRows.length) upsert(path.join(dir, "imts_daily.csv"), IMT_DAILY_COLS, (r) => `${r.run_time}|${r.incident_commander}|${r.team}`, imtRows, (r) => `${r.run_time}|${r.incident_commander}`);
}

/* Goes back through every archived run's snapshot and
   • recomputes model_* (the PL the CURRENT criteria in js/config.js give for that run), so changed
     thresholds or weights can be judged against the whole archive, not just new runs;
   • fills columns that didn't exist when the run was made (old-method PLs, Fire Activity parts, 7-Day halves);
   • fills outlook_psa_daily.csv and ercy_psa_daily.csv from runs made before those files existed.
   Values that were published at the time (pl, score, ratings) are never changed. */
function refreshFromSnapshots({ root, calc, C }) {
  const dir = path.join(root, "data", "archive");
  const file = path.join(dir, "history.csv");
  const rows = readTable(file);
  let updated = 0, missing = 0;
  for (const row of rows) {
    const snap = row.snapshot && path.join(root, row.snapshot);
    if (!snap || !fs.existsSync(snap)) { missing++; continue; }
    let state;
    try { state = JSON.parse(fs.readFileSync(snap, "utf8")).state; } catch (e) { missing++; continue; }
    if (!state) { missing++; continue; }
    const live = { ...state, preset: C.weightPresets[state.preset] ? state.preset : C.defaultPreset, fire: { ...(state.fire || {}) } };
    if (live.fire && !live.fire.fetchedAt && !live.fire.override && state.fire && state.fire.rating) live.fire.override = state.fire.rating; // hand-entered then
    const model = calc.compute(live);
    const full = historyRow(state, { ...calc.compute(state), model, compare: { shoulder: calc.oldMethod(state, "shoulder"), season: calc.oldMethod(state, "season") },
      alt: { with: calc.compute(live, { includeT2IA: true }), without: calc.compute(live, { includeT2IA: false }) } }, row.run_time, row.snapshot, C);
    const keep = new Set(["run_time", "run_date", "run_slot", "pl", "score", "weights", "snapshot"]);
    for (const [k, v] of Object.entries(full)) {
      if (keep.has(k)) continue;
      if (k.startsWith("model_") || /_(with|without)_t2ia$/.test(k)) { if (String(row[k]) !== String(v)) { row[k] = v; updated++; } }
      else if (row[k] === undefined || row[k] === "") { if (v !== "" && v !== undefined) { row[k] = v; updated++; } }
    }
    writeOutlookErcy(dir, state, C);
  }
  if (rows.length) writeTable(file, HISTORY_COLS, rows);
  return { runs: rows.length, updated, missing };
}

/* Writes everything for one run. Returns a short summary. */
function archiveRun({ root, state, result, runTime, C }) {
  const dir = path.join(root, "data", "archive");
  const snapRel = `data/archive/snapshots/${runTime.slice(0, 4)}/${runTime.slice(0, 10)}_${runTime.slice(11, 13)}${runTime.slice(14, 16)}.json`;
  fs.mkdirSync(path.dirname(path.join(root, snapRel)), { recursive: true });
  fs.writeFileSync(path.join(root, snapRel), JSON.stringify({ runTime, pl: result.pl, score: result.score, state }));

  const runs = upsert(path.join(dir, "history.csv"), HISTORY_COLS, (r) => r.run_time, [historyRow(state, result, runTime, snapRel, C)]);

  let days = 0, fires = 0;
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
  const raws = writeRaws(dir, state.raws, runTime);
  writeOutlookErcy(dir, state, C);
  writeForecastActual(dir, state, runTime);
  writeCrewsImts(dir, state, runTime);
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

module.exports = { archiveRun, writeRaws, writeOutlookErcy, writeForecastActual, writeCrewsImts, refreshFromSnapshots, historyRow, parseCsv, readTable, writeTable, upsert, HISTORY_COLS };
