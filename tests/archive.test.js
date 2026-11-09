// Run with: node tests/archive.test.js
// Fire starts (WFIGS), RAWS (FEMS weatherObs) and the daily archive, against simulated service responses.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const C = require("../js/config.js");
const calc = require("../js/calc.js")(C);
const { makeFireStarts, localMidnightUtc } = require("../scripts/lib/firestarts.cjs");
const { makeRaws } = require("../scripts/lib/raws.cjs");
const A = require("../scripts/lib/archive.cjs");

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
// Two square "PSAs": SW-01 covers lon -114..-112, SW-08 covers lon -109..-108 (lat 33..36)
const square = (x0, x1) => [[[x0, 33], [x1, 33], [x1, 36], [x0, 36], [x0, 33]]];
const polys = { "SW-01": square(-114, -112), "SW-08": square(-109, -108) };
const t = (iso, hh) => localMidnightUtc(iso, "America/Denver") + hh * 36e5;
const fire = (id, cause, ms, x, y, acres, state = "US-AZ") => ({ attributes: { UniqueFireIdentifier: id, IncidentName: id, FireCause: cause,
  FireDiscoveryDateTime: ms, IncidentSize: acres, POOState: state, POODispatchCenterID: "AZFDC", IncidentTypeCategory: "WF" }, geometry: { x, y } });

async function wfigs(url) {
  if (/FeatureServer\/0\?f=json/.test(url)) return ok({ fields: ["UniqueFireIdentifier", "IncidentName", "FireCause", "FireCauseGeneral", "FireDiscoveryDateTime",
    "IncidentSize", "POOState", "POODispatchCenterID", "IncidentTypeCategory"].map((name) => ({ name })) });
  if (/outlooks_forecast\/MapServer\/0\/query/.test(url)) return ok({ features: Object.entries(polys).map(([k, rings]) => ({ attributes: { nat_code: k.replace("-", "") }, geometry: { rings } })) });
  if (/FeatureServer\/0\/query/.test(url)) {
    const where = decodeURIComponent(url.split("where=")[1].split("&")[0].replace(/\+/g, " "));
    assert.ok(/FireDiscoveryDateTime >= TIMESTAMP/.test(where) && /POOState IN/.test(where) && /IncidentTypeCategory IN \('WF'\)/.test(where));
    return ok({ features: [
      fire("L1", "Natural", t("2026-11-08", 14), -113, 34, 0.1),
      fire("L2", "Natural", t("2026-11-08", 16), -108.5, 34, 2.5),
      fire("H1", "Human", t("2026-11-08", 10), -113, 35, 12),
      fire("U1", "Undetermined", t("2026-11-08", 23.9), -112.5, 34, 0.5),
      fire("OUT", "Human", t("2026-11-08", 12), -100, 34, 1, "US-TX"),   // outside the SW PSAs
      fire("D2", "Human", t("2026-11-07", 9), -113, 34, 1),
    ] });
  }
  throw new Error("unexpected " + url);
}

// FEMS weatherObs: hourly RAWS rows; Key RAWS layer: which station is in which PSA
const hour = (id, h, T, RH, ws, gust, pcp, extra = {}) => ({ station_id: id, station_name: `Stn ${id}`, observation_type: "O",
  observation_time: new Date(t("2026-11-08", h)).toISOString(), temperature: T, relative_humidity: RH, wind_speed: ws, peak_gust_speed: gust, hourly_precip: pcp, ...extra });
async function fems(url, opts) {
  if (/outlooks_forecast\/MapServer\/0\/query/.test(url)) return ok({ features: Object.entries(polys).map(([k, rings]) => ({ attributes: { nat_code: k.replace("-", "") }, geometry: { rings } })) });
  const q = JSON.parse(opts.body).query;
  if (/stationMetaData/.test(q)) {
    assert.ok(/networkName: "RAWS"/.test(q));
    const st = q.match(/stateId: "(\w+)"/)[1];
    const meta = { AZ: [{ station_id: 20207, station_name: "Hualapai", latitude: 34, longitude: -113 }, { station_id: 20212, station_name: "Truxton", latitude: 35, longitude: -112.5 },
      { station_id: 21999, station_name: "Outside", latitude: 34, longitude: -110.5 }],
      NM: [{ station_id: 29999, station_name: "Quiet", latitude: 34, longitude: -108.5 }, { station_id: 20207, station_name: "dup", latitude: 34, longitude: -113 }] }[st] || [];
    return ok({ data: { stationMetaData: { _metadata: { page_count: 1 }, data: meta } } });
  }
  if (/nfdrsObs/.test(q)) {
    assert.ok(/fuelModels: "Y", nfdrType: "O", startDateRange: "2026-11-08", endDateRange: "2026-11-09"/.test(q), q.slice(0, 200));
    assert.ok(!/station_name/.test(q), "nfdrsObs has no station_name field");
    const nf = (id, lst, erc, bi) => ({ station_id: id, observation_time_lst: lst, nfdr_type: "O", fuel_model: "Y", energy_release_component: erc, burning_index: bi });
    return ok({ data: { nfdrsObs: { _metadata: { page_count: 1 }, data: [
      nf(20207, "2026-11-08T12:00:00-07:00", 30, 20), nf(20207, "2026-11-08T13:00:00-07:00", 32, 22), nf(20207, "2026-11-08T16:00:00-07:00", 35, 30),
      nf(20212, "2026-11-08T14:00:00-07:00", 40, 26), nf(20212, "2026-11-09T13:00:00-07:00", 99, 99), nf(20211, "2026-11-08T13:00:00-07:00", 50, 40) ] } } });
  }
  assert.ok(/weatherObs\(startDateTimeRange: "2026-11-08T07:00:00Z", endDateTimeRange: "2026-11-09T06:59:59Z"/.test(q), q.slice(0, 160));
  assert.ok(/per_page: 1000/.test(q) && /stationIds: "20207,20212,29999"/.test(q), q.slice(0, 220));
  return ok({ data: { weatherObs: { _metadata: { page_count: 1 }, data: [
    hour(20207, 13, 75, 11, 12, 31, 0), hour(20207, 15, 71, 14, 10, 20, 0.12), hour(20207, 16, 99, 2, 50, 70, 0, { t_flag: 2, rh_flag: 2, gs_flag: 2, ws_flag: 2 }),
    hour(20212, 14, 81, 9, 22, null, 0), hour(20212, 15, 80, 12, 15, null, 0),
    { ...hour(20212, 10, 90, 5, 5, 5, 0), observation_type: "F" } ] } } });
}

let state0 = {};
(async () => {
  const FS = makeFireStarts(C, wfigs);
  const f = await FS.fetchStarts({ from: "2026-11-07", to: "2026-11-08" });
  assert.strictEqual(f.placedByPsa, true);
  assert.deepStrictEqual(f.fires.map((x) => `${x.id}:${x.cause}:${x.psa}:${x.date}`),
    ["D2:human:SW-01:2026-11-07", "H1:human:SW-01:2026-11-08", "L1:lightning:SW-01:2026-11-08", "L2:lightning:SW-08:2026-11-08", "U1:unknown:SW-01:2026-11-08"]);
  assert.deepStrictEqual(f.daily["2026-11-08"], { total: 4, lightning: 2, human: 1, unknown: 1, acres: 15.1,
    byPsa: { "SW-01": { total: 3, lightning: 1, human: 1, unknown: 1 }, "SW-08": { total: 1, lightning: 1, human: 0, unknown: 0 } } });
  assert.strictEqual(f.daily["2026-11-07"].total, 1);
  console.log("ok - fire starts: by local day, cause (Natural→lightning, Undetermined→unknown) and PSA; out-of-area fire dropped");

  const RW = makeRaws(C, fems);
  const w = await RW.fetchRaws({ date: "2026-11-08" });
  assert.deepStrictEqual(w.byPsa["SW-01"], { stations: 2, stationsListed: 2, avgMaxTemp: 78, avgMinRh: 10, lowestRh: 9, maxGust: 31, avgPrecip: 0.06, wettingRain: 1 });
  assert.strictEqual(w.byPsa["SW-02"].stations, 0);
  assert.strictEqual(w.byPsa["SW-08"].stationsListed, 1); // NM station placed by location; the out-of-area AZ station dropped
  const nfd = await RW.fetchNfdr({ date: "2026-11-08" });
  assert.deepStrictEqual(nfd.byPsa["SW-01"], { stations: 2, stationsListed: 3, erc: 36, bi: 24, ercMax: 37.5, biMax: 28 });
  assert.deepStrictEqual(nfd.stations.filter((x) => x.psa === "Other" && x.erc !== "").map((x) => `${x.name}:${x.erc}`), ["Bright Angel:50"]);
  const nq = []; await makeRaws(C, async (u, o) => { nq.push(JSON.parse(o.body).query); return fems(u, o); }).fetchNfdr({ date: "2026-11-08" });
  assert.ok(/stationIds: "20207,20212,20213,20115/.test(nq[0]), "ERC/BI uses the SWCC station list");
  console.log("ok - FEMS ERC/BI fuel model Y: SWCC station list only; 13:00 reading per station, daily max, averaged per PSA; 'Other' stations kept separately");
  state0.femsNfdr = nfd;
  console.log("ok - RAWS from FEMS weatherObs: all RAWS in AZ/NM/TX/OK placed in PSAs by location; max temp, min RH, max gust (sustained wind when no gust), 24-h precip; flagged and forecast rows dropped");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plarch-"));
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/current.json"), "utf8"));
  state.fireStarts = f; state.raws = w; state.femsNfdr = state0.femsNfdr;
  const r = calc.compute(state);
  const a1 = A.archiveRun({ root: dir, state, result: r, runTime: "2026-11-09T08:02", C });
  const a2 = A.archiveRun({ root: dir, state, result: r, runTime: "2026-11-09T21:01", C });
  const again = A.archiveRun({ root: dir, state, result: r, runTime: "2026-11-09T21:01", C }); // re-run same minute: replaced, not duplicated
  const hist = A.readTable(path.join(dir, "data/archive/history.csv"));
  assert.strictEqual(hist.length, 2);
  assert.deepStrictEqual(hist.map((h) => h.run_slot), ["AM", "PM"]);
  assert.strictEqual(hist[0].starts_total, "4");
  assert.strictEqual(hist[0].raws_lowest_rh, "9");
  assert.strictEqual(hist[0].pl, String(r.pl));
  assert.ok(fs.existsSync(path.join(dir, a1.snapshot)) && a2.snapshot.endsWith("2026-11-09_2101.json"));
  const daily = A.readTable(path.join(dir, "data/archive/fire_starts_daily.csv"));
  assert.deepStrictEqual(daily.map((d) => `${d.date}:${d.total}:${d.lightning}:${d["psa_SW-01"]}`), ["2026-11-07:1:0:1", "2026-11-08:4:2:3"]);
  assert.strictEqual(A.readTable(path.join(dir, "data/archive/fire_starts.csv")).length, 5);
  assert.strictEqual(A.readTable(path.join(dir, "data/archive/raws_daily.csv")).length, C.psas.length);
  assert.strictEqual(again.runs, 2);
  assert.strictEqual(hist[0].fems_erc_avg, "36");
  const nrows = A.readTable(path.join(dir, "data/archive/fems_erc_bi_daily.csv"));
  assert.strictEqual(nrows.find((x) => x.psa === "SW-01").erc_daily_max, "37.5");
  console.log("ok - archive: snapshot per run, history.csv (AM/PM rows, no duplicates), daily starts, fire list, RAWS and FEMS ERC/BI by PSA");
  console.log("\narchive checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
