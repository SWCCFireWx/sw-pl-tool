// Run with: node tests/review.test.js
// The Season Review re-scores archived runs from their history.csv inputs. These checks make sure that
// gives exactly what the live calculation gave, and that the review tables add up.
const assert = require("assert");
const C = require("../js/config.js");
const calc = require("../js/calc.js")(C);
const RV = require("../js/review.js")(C);
const { historyRow } = require("../scripts/lib/archive.cjs");
const seed = require("./fixtures/state.json");
const clone = (o) => JSON.parse(JSON.stringify(o));
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok -", name); };

// deterministic random states
let seedN = 7;
const rnd = () => ((seedN = (seedN * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
function randomState() {
  const s = clone(seed);
  s.preset = "shoulder"; s.modelVersion = 2;
  for (const k in s.outlook.values) s.outlook.values[k] = s.outlook.values[k].map(() => pick([1, 1, 1, 2, 2, 3, 4]));
  Object.values(s.danger.rows).forEach((x) => (x.ercPct = pick([20, 45, 60, 85, 91, 95, 97, 99])));
  s.imts.forEach((x) => (x.status = pick(["AN", "AL", "C", "O-R", "UE"])));
  s.crews.forEach((x) => (x.status = pick(["A", "C", "UE", "P"])));
  s.fire = { fetchedAt: "2026-07-01T08:00", complex: pick([0, 0, 1, 2, 3, 5]), t3: pick([0, 0, 1, 3, 6, 12]), startsAvg3: pick([0, 0.7, 3, 9, 25, 45]), escapes: pick([0, 0, 1, 2, 5]) };
  return s;
}

t("re-scoring a run from history.csv gives the same PL, score, hold and Fire Activity as the live calculation (300 random runs)", () => {
  const cri = RV.criteria();
  for (let i = 0; i < 300; i++) {
    const s = randomState();
    const r = calc.compute(s);
    const row = historyRow(s, { ...r, compare: {} }, "2026-07-01T08:00", "", C);
    const csvRow = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === undefined || v === null ? "" : String(v)])); // as read back from the CSV
    const x = RV.scoreRun(csvRow, cri);
    assert.deepStrictEqual([x.pl, x.score, x.held, x.fire.rating], [r.pl, r.score, r.held, r.fire.rating], `run ${i}: ${JSON.stringify(s.fire)}`);
  }
});

t("archived fire-season runs are re-scored with fire-season weights (each run keeps its season)", () => {
  const cri = RV.criteria();
  for (let i = 0; i < 100; i++) {
    const s = randomState(); s.preset = "season";
    const r = calc.compute(s);
    const row = Object.fromEntries(Object.entries(historyRow(s, { ...r, compare: {} }, "2026-07-01T08:00", "", C)).map(([k, v]) => [k, String(v ?? "")]));
    assert.strictEqual(row.weights, "season");
    const x = RV.scoreRun(row, cri);
    assert.deepStrictEqual([x.pl, x.score], [r.pl, r.score], `run ${i}`);
  }
});

t("trial criteria change the result the way the config would", () => {
  const s = randomState();
  s.fire = { fetchedAt: "x", complex: 0, t3: 0, startsAvg3: 0, escapes: 0 };
  for (const k in s.outlook.values) s.outlook.values[k] = [4, 4, 4, 4, 4, 4, 4];
  Object.values(s.danger.rows).forEach((x) => (x.ercPct = 98));
  const row = Object.fromEntries(Object.entries(historyRow(s, { ...calc.compute(s), compare: {} }, "t", "", C)).map(([k, v]) => [k, String(v ?? "")]));
  assert.strictEqual(RV.scoreRun(row, RV.criteria()).pl, 2); // held at PL2: no fire
  assert.strictEqual(RV.scoreRun(row, RV.criteria({ plGate: { maxPlWithoutFire: 0 } })).pl, 4); // no hold (shoulder weights: score 0.7)
  assert.strictEqual(RV.scoreRun(row, RV.criteria({ plGate: { maxPlWithoutFire: 3 } })).pl, 3);
  row.fire_starts_avg3 = "5";
  assert.strictEqual(RV.scoreRun(row, RV.criteria()).fire.rating, "Moderate"); // Low +1 (7-Day already Maximum)
  assert.strictEqual(RV.scoreRun(row, RV.criteria({ fireActivityModel: { startsPerDay: [{ rating: "Low", atLeast: 6 }, { rating: "Moderate", atLeast: 10 }, { rating: "High", atLeast: 20 }, { rating: "Maximum", atLeast: 40 }] } })).fire.rating, "Minimum");
});

t("days, PL outcomes, element checks, thresholds and misses over an archive", () => {
  const daily = [], history = [];
  const base = "2026-05-01";
  for (let i = 0; i < 60; i++) {
    const date = RV.addDays(base, i);
    const busy = i >= 20 && i < 40; // a busy 3 weeks
    const total = busy ? 15 + (i % 5) : i % 3;
    daily.push({ date, total: String(total), lightning: String(busy ? 10 : 0), human: String(total - (busy ? 10 : 0)), unknown: "0", acres: String(total * 10), "psa_SW-01": String(total) });
    // PL rises ahead of the busy spell (days 15–39)
    const pl = i >= 15 && i < 40 ? 3 : i % 7 === 0 ? 2 : 1;
    history.push({ run_time: `${date}T08:00`, run_date: date, run_slot: "AM", pl: String(pl), score: String(pl / 5), model_pl: String(pl), model_score: String(pl / 5),
      old_shoulder_pl: "1", old_shoulder_score: "0", old_season_pl: "2", old_season_score: "0.25", fire_rating: pl >= 3 ? "Moderate" : "Minimum", model_fire_rating: pl >= 3 ? "Moderate" : "Minimum",
      outlook_rating: pl >= 3 ? "High" : "Minimum", danger_rating: "Low", imt_rating: "High", crews_rating: "Moderate", fire_complex: "0", fire_t3: pl >= 3 ? "2" : "0", fire_escapes: "0" });
  }
  const days = RV.buildDays({ history, daily });
  assert.strictEqual(days.length, 60);
  assert.strictEqual(days[0].next7, [1, 2, 3, 4, 5, 6, 7].reduce((a, i) => a + (i % 3), 0));
  assert.strictEqual(days[59].next7, null); // the week after isn't in yet
  assert.strictEqual(days[3].starts3, 1); // days 0–2 had 0, 1, 2 starts
  const out = RV.plOutcomes(days, RV.methodsFor(false));
  const m = out.model.rows;
  assert.deepStrictEqual(m.map((r) => r.days), [29, 6, 25, 0, 0]); // PL3 days 15–39; PL2 every 7th day otherwise
  assert.strictEqual(out.model.verdict.status, "ok");
  assert.ok(m[2].next7 > m[0].next7);
  const el = RV.elementOutcomes(days, false);
  const crews = el.find((e) => e.key === "crews");
  assert.ok(crews.notes.some((n) => /hardly moves/.test(n.text)), "a rating stuck on 100% of days is flagged");
  const th = RV.thresholds(days, RV.criteria());
  assert.ok(th.startsAvg3.n > 50 && th.startsAvg3.max >= 15);
  const ms = RV.misses(days, (d) => +d.run.model_pl);
  assert.ok(ms.high.every((d) => +d.run.model_pl >= 3) && ms.low.every((d) => +d.run.model_pl <= 2));
  const st = RV.stability(days, (d) => +d.run.model_pl);
  assert.ok(st.changes > 0 && st.highest === 3);
  assert.ok(RV.correlation(days, (d) => +d.run.model_score) > 0.3);
});

t("per-PSA checks: 7-Day Day 1 level and ERCy percentile vs starts in that PSA", () => {
  const daily = [], outlookPsa = [], ercyPsa = [], raws = [];
  for (let i = 0; i < 30; i++) {
    const date = RV.addDays("2026-06-01", i), hot = i % 2 === 0;
    daily.push({ date, total: hot ? "6" : "0", "psa_SW-01": hot ? "6" : "0", "psa_SW-02": "0" });
    outlookPsa.push({ date, psa: "SW-01", d1: hot ? "4" : "1" }, { date, psa: "SW-02", d1: "1" });
    ercyPsa.push({ date, psa: "SW-01", erc_pct: hot ? "98" : "40" });
    raws.push({ date, psa: "SW-01", lowest_rh: hot ? "8" : "30", wind_event: "no", wetting_rain_stations: "0" });
  }
  const arch = { daily, outlookPsa, ercyPsa, raws };
  const o = RV.outlookCheck(arch);
  assert.ok(o.rows[3].psaDays > 0 && o.rows[3].avg > o.rows[0].avg);
  const e = RV.ercyCheck(arch);
  assert.ok(e.rows[3].avg > e.rows[0].avg);
  const w = RV.weatherCheck(arch);
  assert.ok(w.rh[0].psaDays > 0);
});

t("imported published PLs (published_pl.csv) fill days with no archived run, and are never re-scored", () => {
  const daily = [0, 1, 2, 3, 4].map((i) => ({ date: RV.addDays("2026-06-01", i), total: String(10 + i) }));
  const history = [{ run_time: "2026-06-03T08:00", run_date: "2026-06-03", run_slot: "AM", pl: "3", model_pl: "2", score: "0.4" }];
  const imported = [{ date: "2026-06-01", pl: "2" }, { date: "2026-06-02", pl: "2" }, { date: "2026-06-03", pl: "1" }];
  const days = RV.buildDays({ history, daily, imported });
  assert.deepStrictEqual(days.map((d) => d.run && d.run.pl), ["2", "2", "3", null, null]); // the archived run wins on 6/3
  const M = RV.METHODS;
  assert.strictEqual(M.published.pl(days[0]), 2);
  assert.strictEqual(M.model.pl(days[0]), null);
  assert.strictEqual(M.model.pl(days[2]), 2);
  assert.ok(!RV.withTrial(days, RV.criteria())[0].trial && RV.withTrial(days, RV.criteria())[2].trial);
  assert.strictEqual(days[4].iaStarts, "Moderate"); // 11, 12, 13 starts the 3 days before → 12/day
});

t("forecast vs actual: hits, within 1, error and 'no change' by lead", () => {
  const forecasts = [
    { issued: "2026-06-01T08:00", issued_date: "2026-06-01", lead_days: "0", target_date: "2026-06-01", pl: "2" },
    { issued: "2026-06-01T08:00", issued_date: "2026-06-01", lead_days: "1", target_date: "2026-06-02", pl: "3" },
    { issued: "2026-06-01T08:00", issued_date: "2026-06-01", lead_days: "2", target_date: "2026-06-03", pl: "3" },
    { issued: "2026-06-02T08:00", issued_date: "2026-06-02", lead_days: "1", target_date: "2026-06-03", pl: "4" },
  ];
  const actual = [{ date: "2026-06-02", pl: "3", source: "NICC" }, { date: "2026-06-03", pl: "3", source: "NICC" }];
  const imported = [{ date: "2026-06-01", pl: "2" }, { date: "2026-06-02", pl: "2" }]; // NICC wins on 6/2
  const r = RV.forecastCheck({ forecasts, actual, imported });
  const by = Object.fromEntries(r.rows.map((x) => [x.lead, x]));
  assert.deepStrictEqual([by[0].n, by[0].exact], [1, 1]);
  assert.deepStrictEqual([by[1].n, by[1].exact, by[1].within1, by[1].bias], [2, 0.5, 1, 0.5]);
  assert.deepStrictEqual([by[1].persistExact, by[1].persistMae], [0.5, 0.5]); // 6/1 PL2→6/2 PL3 miss; 6/2 PL3→6/3 PL3 hit
  assert.strictEqual(by[2].exact, 1);
  assert.strictEqual(r.misses.length, 1);
});

console.log(`\n${passed} review checks passed`);
