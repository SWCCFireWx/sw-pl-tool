// Run with: node tests/calc.test.js
// Checks the calculation engine against results produced by the Excel workbook.
const assert = require("assert");
const C = require("../js/config.js");
const calc = require("../js/calc.js")(C);
const seed = require("../data/current.json");
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

t("Weights in each preset total 1.0", () => {
  for (const p of Object.values(C.weightPresets)) {
    const sum = Object.values(p.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, p.label);
  }
});

console.log(`\n${passed} checks passed`);
