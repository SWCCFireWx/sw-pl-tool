// Run with: node tests/sources.test.js
// Exercises the NPSG and FEMS parsers against canned responses shaped like the real services.
const assert = require("assert");
const C = require("../js/config.js");
const makeSources = require("../js/sources.js");

const day1 = Date.UTC(2026, 10, 4);
function arcFeatures(layer) {
  return C.psas.map((p, i) => ({ attributes: {
    nat_code: p.id, timestampdate: day1 + layer * 864e5, isvalid: 1,
    drynesscode: i < 3 ? 3 : i < 6 ? 2 : 1,
    type: i === 0 && layer === 2 ? "IGNITION" : i === 1 && layer === 3 ? "CRITICAL" : null,
  } }));
}
const keyRaws = C.psas.flatMap((p, i) => [
  { attributes: { STATION_ID: String(20100 + i * 2), STA_NAME: `${p.id} A`, NAT_CODE: p.id } },
  { attributes: { STATION_ID: String(20101 + i * 2), STA_NAME: `${p.id} B`, NAT_CODE: p.id } },
]);
const levels = { "50th": 30, "90th": 60, "97th": 70 };

async function fakeFetch(url, opts = {}) {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.includes("outlooks_forecast")) return ok({ features: arcFeatures(+url.match(/MapServer\/(\d)\/query/)[1]) });
  if (url.includes("KeyRAWS")) return ok({ features: keyRaws });
  const q = JSON.parse(opts.body).query;
  if (q.includes("percentileLevels")) {
    const ids = q.match(/stationIds: "([^"]+)"/)[1].split(",");
    return ok({ data: { percentileLevels: { _metadata: { page_count: 1 }, data: ids.map((id) => ({ station_id: +id, energy_release_component: levels, burning_index: levels })) } } });
  }
  if (q.includes("nfdrsObs")) {
    const ids = q.match(/stationIds: "([^"]+)"/)[1].split(",");
    const data = ids.flatMap((id) => [12, 13, 14].map((h) => ({ station_id: +id, nfdr_type: "O", fuel_model: "Y",
      observation_time_lst: `2026-11-03T${h}:00:00-07:00`,
      energy_release_component: +id % 2 ? 60 : 40, burning_index: h === 13 ? 30 : 99 })));
    return ok({ data: { nfdrsObs: { _metadata: { page_count: 1 }, data } } });
  }
  throw new Error("unexpected " + url);
}

(async () => {
  const S = makeSources(C, fakeFetch);
  const o = await S.fetchOutlook();
  assert.strictEqual(o.startDate, "2026-11-04");
  assert.deepStrictEqual(o.values.SW01, [3, 3, 4, 3, 3, 3, 3]);
  assert.deepStrictEqual(o.values.SW02, [3, 3, 3, 4, 3, 3, 3]);
  assert.deepStrictEqual(o.values.SW14N, [1, 1, 1, 1, 1, 1, 1]);
  console.log("ok - 7-Day levels: drynesscode 1-3, CRITICAL/IGNITION = 4");

  const stations = await S.fetchStations();
  assert.strictEqual(stations["SW-01"].length, 2);
  const clim = await S.fetchClimatology(stations);
  const d = await S.fetchDanger({ date: "2026-11-03", climatology: clim });
  assert.strictEqual(d.rows["SW-01"].ercVal, 50);      // (40 + 60) / 2
  assert.strictEqual(d.rows["SW-01"].biVal, 30);       // 13:00 reading chosen
  assert.strictEqual(d.rows["SW-01"].ercPct, 77);      // 50 is 2/3 of the way from 30 (50th) to 60 (90th)
  assert.strictEqual(d.rows["SW-01"].stations, 2);
  console.log("ok - FEMS: PSA average of previous-day 13:00 values, percentile from station climatology");

  assert.strictEqual(S.percentileOf(65, [[50, 30], [90, 60], [97, 70]]), 94);
  assert.strictEqual(S.percentileOf(80, [[50, 30], [90, 60], [97, 70]]), 97);
  assert.strictEqual(S.previousDay(new Date("2026-11-04T05:00:00Z")), "2026-11-02"); // 22:00 Nov 3 in Denver
  console.log("ok - percentile interpolation and previous day in America/Denver");
  console.log("\nsource checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
