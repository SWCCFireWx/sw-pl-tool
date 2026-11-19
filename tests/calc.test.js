// Run with: node tests/calc.test.js
// Checks the calculation engine against results produced by the Excel workbook.
const assert = require("assert");
const C = require("../js/config.js");
const calc = require("../js/calc.js")(C);
const seed = require("./fixtures/state.json"); // the spreadsheet seed (11/3–11/4/2026)
const clone = (o) => JSON.parse(JSON.stringify(o));
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok -", name); };

t("seed data, shoulder season = PL1 score 0 (PL_Outcome sheet)", () => {
  const r = calc.compute(seed);
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.pl, 1);
  assert.deepStrictEqual(r.elements.map((e) => e.rating), ["Minimum", "Low", "Minimum", "Minimum", "Minimum"]);
});

t("seed data, fire season weights = PL2 score 0.25 (PL_Outcome (2) sheet)", () => {
  const r = calc.compute({ ...seed, preset: "season" });
  assert.strictEqual(r.score, 0.25);
  assert.strictEqual(r.pl, 2);
});

t("PL score boundaries follow MISC!E2:G6", () => {
  assert.strictEqual(calc.plLevel(0.15), 1);
  assert.strictEqual(calc.plLevel(0.151), 2);
  assert.strictEqual(calc.plLevel(0.385), 2);
  assert.strictEqual(calc.plLevel(0.386), 3);
  assert.strictEqual(calc.plLevel(0.62), 4);
  assert.strictEqual(calc.plLevel(0.85), 4);
  assert.strictEqual(calc.plLevel(0.851), 5);
});

t("7-Day risk score bands (7-Day_Dryness!D35)", () => {
  assert.strictEqual(calc.outlookRating(15), "Minimum");
  assert.strictEqual(calc.outlookRating(24), "Minimum");
  assert.strictEqual(calc.outlookRating(25), "Low");
  assert.strictEqual(calc.outlookRating(37), "Moderate");
  assert.strictEqual(calc.outlookRating(46), "High");
  assert.strictEqual(calc.outlookRating(52), "Maximum");
  const s = clone(seed);
  for (const k in s.outlook.values) s.outlook.values[k] = [3, 3, 3, 3, 3, 3, 3];
  const o = calc.outlookSummary(s.outlook);
  assert.strictEqual(o.daily[0].score, 45);
  assert.strictEqual(o.rating, "Moderate");
});

t("ERCy metric (PSA_ERCy_Values!D28)", () => {
  const s = clone(seed);
  const set = (vals) => Object.keys(s.danger.rows).forEach((k, i) => (s.danger.rows[k].ercPct = vals[i] ?? 45));
  set([60]); assert.strictEqual(calc.dangerSummary(s.danger).rating, "Low");
  set([92]); assert.strictEqual(calc.dangerSummary(s.danger).rating, "Moderate");
  set([97]); assert.strictEqual(calc.dangerSummary(s.danger).rating, "High");
  set([97, 97, 97, 97, 97, 97, 97, 98]); assert.strictEqual(calc.dangerSummary(s.danger).rating, "Extreme");
});

t("IMT availability (IMT's!D43)", () => {
  const teams = (cimtAvail, t3Avail) => [
    ...Array.from({ length: 4 }, (_, i) => ({ type: "CIMT", status: i < cimtAvail ? "AN" : "O-R" })),
    ...Array.from({ length: 8 }, (_, i) => ({ type: "3", status: i < t3Avail ? "AL" : "UE" })),
  ];
  assert.strictEqual(calc.imtSummary(teams(0, 8)).rating, "Minimum");
  assert.strictEqual(calc.imtSummary(teams(2, 0)).rating, "Low");
  assert.strictEqual(calc.imtSummary(teams(3, 0)).rating, "Moderate");
  assert.strictEqual(calc.imtSummary(teams(4, 3)).rating, "High");
  assert.strictEqual(calc.imtSummary(teams(4, 4)).rating, "Maximum");
});

t("Crew availability ratio bands (Crews!N44)", () => {
  const crews = (n) => Array.from({ length: 20 }, (_, i) => ({ status: i < n ? "A" : "UE" }));
  assert.strictEqual(calc.crewSummary(crews(2), []).rating, "Minimum");   // 10%
  assert.strictEqual(calc.crewSummary(crews(3), []).rating, "Low");       // 15%
  assert.strictEqual(calc.crewSummary(crews(8), []).rating, "Moderate");  // 40%
  assert.strictEqual(calc.crewSummary(crews(13), []).rating, "High");     // 65%
  assert.strictEqual(calc.crewSummary(crews(20), []).rating, "Maximum");
  const prepo = crews(0); prepo[0] = { status: "P", location: "SWCC" }; prepo[1] = { status: "P", location: "PHC" };
  assert.strictEqual(calc.crewSummary(prepo, []).totalAvail, 1);
});

t("Fire activity suggestion from incident counts", () => {
  assert.strictEqual(calc.fireActivity({ complex: 0, t3: 0 }).suggested, "Minimum");
  assert.strictEqual(calc.fireActivity({ complex: 1, t3: 2 }).suggested, "Low");
  assert.strictEqual(calc.fireActivity({ complex: 2, t3: 1 }).suggested, "Moderate");
  assert.strictEqual(calc.fireActivity({ complex: 3, t3: 10 }).suggested, "High");
  assert.strictEqual(calc.fireActivity({ complex: 5, t3: 0 }).suggested, "Maximum");
});

/* ---------- year-round model (v2) ---------- */
const auto = (fire, extra = {}) => ({ ...clone(seed), preset: "shoulder", ...extra, fire: { fetchedAt: "2026-11-16T08:00", ...fire } });
const teams = (cimtAvail) => Array.from({ length: 4 }, (_, i) => ({ type: "CIMT", status: i < cimtAvail ? "AN" : "C" }));
const crewsAvail = (n) => Array.from({ length: 20 }, (_, i) => ({ status: i < n ? "A" : "C" }));

t("Fire Activity demand = higher of large fires and initial attack", () => {
  assert.strictEqual(calc.compute(auto({ complex: 0, t3: 0, startsAvg3: 0, escapes: 0 })).fire.rating, "Minimum");
  assert.strictEqual(calc.compute(auto({ complex: 0, t3: 0, startsAvg3: 9, escapes: 0 }, { imts: teams(4), crews: crewsAvail(20) })).fire.rating, "Moderate");
  assert.strictEqual(calc.compute(auto({ complex: 1, t3: 2, startsAvg3: 1, escapes: 4 }, { imts: teams(4), crews: crewsAvail(20) })).fire.rating, "High");
});

t("Fire Activity: +1 for strained IMTs/crews, +1 for a rising 7-day; never from Minimum", () => {
  const st = auto({ complex: 1, t3: 2, startsAvg3: 0, escapes: 0 }, { imts: teams(1), crews: crewsAvail(20) });
  let f = calc.compute(st).fire;
  assert.strictEqual(f.demand, "Low"); assert.strictEqual(f.rating, "Moderate"); assert.strictEqual(f.steps[0].kind, "capacity");
  for (const k in st.outlook.values) st.outlook.values[k] = [1, 1, 1, 2, 3, 3, 3];
  st.outlook.values[Object.keys(st.outlook.values)[0]] = [1, 1, 1, 4, 4, 4, 1];
  f = calc.compute(st).fire;
  assert.deepStrictEqual(f.steps.map((x) => x.kind), ["capacity", "outlook"]); assert.strictEqual(f.rating, "High");
  const quiet = auto({ complex: 0, t3: 0, startsAvg3: 0, escapes: 0 }, { imts: teams(0), crews: crewsAvail(0), outlook: st.outlook });
  assert.strictEqual(calc.compute(quiet).fire.rating, "Minimum");
});

t("Resources step counts only teams and crews busy in the Southwest, never out of area, off rotation or unavailable", () => {
  const fire = { complex: 1, t3: 2, startsAvg3: 0, escapes: 0 }; // demand Low
  const cimts = (list) => list.map(([status, extra]) => ({ type: "CIMT", status, ...(extra || {}) }));
  const crews = (n, status) => Array.from({ length: 20 }, (_, i) => ({ status: i < n ? status : "A" }));
  const step = (imts, cr) => calc.compute(auto(fire, { imts, crews: cr })).fire.steps.map((x) => x.kind);
  // 3 of 4 CIMTs out of area (Idaho, Northwest) or off rotation: no step
  assert.deepStrictEqual(step(cimts([["C", { incState: "ID" }], ["C", { incDisp: "NWCC" }], ["O-R"], ["AN"]]), crews(15, "C-O")), []);
  // the same, all season-unavailable: no step
  assert.deepStrictEqual(step(cimts([["UE"], ["UE"], ["O-R"], ["O-R"]]), crews(20, "UE")), []);
  // 2 CIMTs on Southwest incidents: step
  assert.deepStrictEqual(step(cimts([["C", { incState: "NM" }], ["C", { incDisp: "AZ-PHC" }], ["AN"], ["AN"]]), crews(0, "A")), ["capacity"]);
  // 12 of 20 SWA crews committed in SWA (60%): step; 12 committed out of area: none
  assert.deepStrictEqual(step(cimts([["AN"]]), crews(12, "C")), ["capacity"]);
  assert.deepStrictEqual(step(cimts([["AN"]]), crews(12, "C-O")), []);
  const r = calc.compute(auto(fire, { imts: cimts([["C", { incState: "ID" }], ["C", { incState: "AZ" }], ["C"]]), crews: crews(5, "C-O") }));
  assert.deepStrictEqual([r.imt.commCimtSw, r.imt.commOut, r.imt.commNoLocation, r.crews.committedSw, r.crews.committedOut], [2, 1, 1, 0, 5]);
});

t("Crews out of area come out of the pool: 20 crews, 5 out of area, 3 committed in the SW → 3 of 15", () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ status: i < 5 ? "C-O" : i < 8 ? "C" : "A" }));
  const c = calc.crewSummary(list, []);
  assert.deepStrictEqual([c.total, c.committedOut, c.pool, c.committedSw, Math.round(c.committedSwShare * 100), c.totalAvail, Math.round(c.ratio * 100)], [20, 5, 15, 3, 20, 12, 80]);
  assert.strictEqual(c.rating, "High"); // 12 of 15 available (80%), not 12 of 20 (60%)
  const all = calc.crewSummary(Array.from({ length: 4 }, () => ({ status: "C-O" })), []);
  assert.deepStrictEqual([all.pool, all.ratio, all.committedSwShare], [0, 0, 0]); // everyone out of area
});

t("A hand-picked override wins over the automatic rating", () => {
  assert.strictEqual(calc.compute(auto({ complex: 3, t3: 5, override: "Low" })).fire.rating, "Low");
});

t("PL2 gate: no fire on the ground holds the PL at 2", () => {
  const st = auto({ complex: 0, t3: 0, startsAvg3: 0, escapes: 0 });
  for (const k in st.outlook.values) st.outlook.values[k] = [4, 4, 4, 4, 4, 4, 4];
  Object.values(st.danger.rows).forEach((x) => (x.ercPct = 98));
  const r = calc.compute(st);
  assert.ok(r.scorePl >= 3); assert.strictEqual(r.pl, 2); assert.strictEqual(r.held, true);
  st.fire.startsAvg3 = 3; // a little fire on the ground lifts the hold
  const r2 = calc.compute(st);
  assert.strictEqual(r2.held, false); assert.ok(r2.pl >= 3);
});

t("Old spreadsheet method is still available for comparison", () => {
  assert.strictEqual(calc.oldMethod(seed, "shoulder").pl, 1);
  assert.strictEqual(calc.oldMethod(seed, "season").score, 0.25);
  assert.strictEqual(calc.compute({ ...seed, preset: "shoulder" }).pl, 1);
});

t("PL forecast: today + 6 days from this morning's 7-Day (Day 1 = today … Day 7), FEMS forecast ERCy when given", () => {
  const st = clone(seed); st.preset = "shoulder";
  st.outlook.startDate = "2026-11-03";
  for (const k in st.outlook.values) st.outlook.values[k] = [1, 1, 1, 1, 4, 4, 4];
  const f = calc.forecast(st, { today: "2026-11-03" });
  assert.deepStrictEqual(f.map((d) => d.date), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
  assert.deepStrictEqual(f.map((d) => d.outlookDay), [1, 2, 3, 4, 5, 6, 7]);
  // Day N uses Days N–7: averages 34.3, 40, 42, 48.75, 60, 60, 60
  assert.deepStrictEqual(f.map((d) => d.ratings.outlook), ["Low", "Moderate", "Moderate", "High", "Maximum", "Maximum", "Maximum"]);
  assert.strictEqual(f[0].pl, calc.compute(st).pl); // Day 1 = today's PL
  // an outlook issued yesterday only covers 6 more days; nothing is made up past its Day 7
  const g0 = calc.forecast(st, { today: "2026-11-04" });
  assert.deepStrictEqual([g0.length, g0[0].outlookDay, g0[g0.length - 1].date], [6, 2, "2026-11-09"]);
  // forecast ERCy for Nov 5: every PSA at the 97th → Extreme
  st.forecastDanger = { "2026-11-05": { rows: Object.fromEntries(Object.keys(st.danger.rows).map((k) => [k, { ercPct: 97 }])), source: "FEMS forecast ERC/BI" } };
  const g = calc.forecast(st, { today: "2026-11-03" });
  assert.strictEqual(g[2].ratings.danger, "Extreme");
  assert.strictEqual(g[3].ratings.danger, g[0].ratings.danger); // Nov 6 has none: latest observed
  assert.ok(g[2].pl <= 2 && g[2].held, "no fire on the ground: held at PL2");
});

t("SWA Type 2IA crews counted or not in crew availability", () => {
  const st = clone(seed);
  st.crews = Array.from({ length: 10 }, () => ({ status: "C" })); // 0 of 10 available
  st.t2iaCrews = Array.from({ length: 10 }, () => ({ status: "A" })); // 10 of 10 available
  assert.strictEqual(calc.compute(st).crews.ratio, 0);               // config default: not counted
  const w = calc.compute(st, { includeT2IA: true }).crews;
  assert.deepStrictEqual([w.ratio, w.t2iaTotal, w.t2iaAvail, w.rating], [0.5, 10, 10, "Moderate"]);
  st.includeT2IA = true;
  assert.strictEqual(calc.compute(st).crews.ratio, 0.5);
});

t("PL changes only when two scheduled runs in a row agree", () => {
  let pc = calc.confirmPl(null, 1, { now: "d1 am" });                     // first run ever: accepted
  assert.deepStrictEqual([pc.pl, pc.pending], [1, null]);
  pc = calc.confirmPl(pc, 3, { now: "d1 pm" });                            // one run says PL3: waits
  assert.deepStrictEqual([pc.pl, pc.pending.pl, pc.pending.runs, pc.changed], [1, 3, 1, false]);
  pc = calc.confirmPl(pc, 3, { scheduled: false, now: "upload" });         // a run started by an upload doesn't count
  assert.deepStrictEqual([pc.pl, pc.pending.runs], [1, 1]);
  pc = calc.confirmPl(pc, 3, { now: "d2 am" });                            // second scheduled run agrees: changes
  assert.deepStrictEqual([pc.pl, pc.pending, pc.changed, pc.since], [3, null, true, "d2 am"]);
  pc = calc.confirmPl(pc, 2, { now: "d2 pm" }); pc = calc.confirmPl(pc, 3, { now: "d3 am" }); // a one-run dip goes away
  assert.deepStrictEqual([pc.pl, pc.pending], [3, null]);
  pc = calc.confirmPl(pc, 2, { now: "d3 pm" }); pc = calc.confirmPl(pc, 4, { now: "d4 am" }); // two different new PLs don't add up
  assert.deepStrictEqual([pc.pl, pc.pending.pl, pc.pending.runs], [3, 4, 1]);
});

t("Weights in each preset total 1.0", () => {
  for (const p of Object.values(C.weightPresets)) {
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, p.label);
  }
});

t("IMT availability leaves out teams committed out of area (scaled to the full roster)", () => {
  const team = (status, incDisp = "", type = "CIMT") => ({ type, status, incDisp, incState: "" });
  // 4 CIMTs: 3 committed out of area, the 4th available → rated like 4 of 4 available, not 1
  const out3 = calc.imtSummary([team("C", "NWCC"), team("C", "ONCC"), team("C", "NRCC"), team("AN")]);
  assert.deepStrictEqual([out3.availCimt, out3.commOutCimt, out3.ratedCimt, out3.rating], [1, 3, 4, "High"]);
  // 2 out of area, 1 on a Southwest incident, 1 available → 1 of the 2 left in the SW → rated as 2 of 4
  const mix = calc.imtSummary([team("C", "NWCC"), team("C", "ONCC"), team("C", "SWCC"), team("AN")]);
  assert.deepStrictEqual([mix.ratedCimt, mix.rating], [2, "Low"]);
  // the same teams all committed in the Southwest → 0 available → Minimum (raises the PL in fire season)
  const sw = calc.imtSummary([team("C", "SWCC"), team("C", "PHC"), team("C", "ABC"), team("C", "SDC")]);
  assert.deepStrictEqual([sw.ratedCimt, sw.rating], [0, "Minimum"]);
  // fire season: out-of-area teams don't raise the PL score
  const st = clone(seed); st.preset = "season";
  st.imts = [team("C", "NWCC"), team("C", "ONCC"), team("C", "NRCC"), team("AN")];
  const st2 = clone(st); st2.imts = [team("AN"), team("AN"), team("AN"), team("AN")];
  assert.strictEqual(calc.compute(st).elements.find((e) => e.key === "imt").rating, calc.compute(st2).elements.find((e) => e.key === "imt").rating);
});

t("The season in use is set by hand: shoulder and fire season weights", () => {
  assert.ok(["shoulder", "season"].includes(C.defaultPreset));
  assert.deepStrictEqual(calc.compute({ ...seed, preset: "season" }).weights, C.weightPresets.season.weights);
  assert.deepStrictEqual(calc.compute({ ...seed, preset: "shoulder" }).weights, C.weightPresets.shoulder.weights);
});

console.log(`\n${passed} checks passed`);
