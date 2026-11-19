/*
 * Season Review: checks the PL criteria against what actually happened, from the archive CSVs.
 *
 * Everything works from the archive tables (history.csv, fire_starts_daily.csv, raws_daily.csv,
 * outlook_psa_daily.csv, ercy_psa_daily.csv), so it covers every day ever archived, and any date range
 * can be picked. scoreRun() re-scores an archived run from its stored inputs with any criteria, which is
 * how "Try different criteria" shows what a change would have done over a whole season.
 *
 * Works in the browser (window.PL_REVIEW) and in Node (module.exports = factory).
 */
(function (root) {
  "use strict";
  function makeReview(C) {
    const R = ["Minimum", "Low", "Moderate", "High", "Maximum"];
    const ORDER = ["Minimum", "Low", "Moderate", "High", "Maximum", "Extreme"];
    const MULT = C.multipliers, INV = C.invertedMultipliers;
    const idx = (r) => Math.max(0, R.indexOf(r));
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
    const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const r4 = (v) => Math.round(v * 1e4) / 1e4; // same rounding as calc.js
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const clone = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === Infinity ? "Infinity" : v)), (k, v) => (v === "Infinity" ? Infinity : v));

    /* ---------- criteria (a copy of the model settings that can be changed for "what if") ---------- */
    let season = C.defaultPreset; // the published season (data/season.txt), set by the page
    const setSeason = (k) => { if (C.weightPresets[k]) season = k; };
    function criteria(over = {}) {
      const c = {
        weights: { ...C.weightPresets[season].weights },
        bySeason: true, // each archived run is re-scored with the season weights it used (history.csv "weights"); trial weights turn this off
        plLevels: clone(C.plLevels),
        plGate: { ...C.plGate },
        fireActivity: clone(C.fireActivity),
        fireActivityModel: clone(C.fireActivityModel),
        outlookBands: clone(C.outlook.bands),
        extremeCount: C.danger.extremeCount,
      };
      return deepMerge(c, over);
    }
    function deepMerge(a, b) {
      for (const [k, v] of Object.entries(b || {})) {
        if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) deepMerge(a[k], v);
        else a[k] = v;
      }
      return a;
    }

    /* ---------- re-score one archived run (a history.csv row) ---------- */
    const band = (v, bands) => { let r = "Minimum"; for (const b of bands) if (v !== null && v >= b.atLeast) r = b.rating; return r; };
    function plLevel(score, levels) { let pl = levels[0].pl; for (const l of levels) if (score >= l.min - 1e-9) pl = l.pl; return pl; }
    function scoreRun(run, cri, extra = {}) {
      const M = cri.fireActivityModel;
      // Fire Activity
      let fire;
      const mode = run.fire_mode;
      if (mode === "override" || mode === "manual" || (!mode && run.fire_rating && num(run.fire_complex) === null)) fire = { rating: run.fire_rating || "Minimum", demand: run.fire_rating || "Minimum", steps: [] };
      else {
        const complex = num(run.fire_complex) || 0, t3 = num(run.fire_t3) || 0, total = complex + t3;
        let large = "Maximum";
        for (const l of cri.fireActivity) if (total <= l.maxIncidents && complex <= l.maxComplex) { large = l.rating; break; }
        const starts = num(run.fire_starts_avg3) ?? (extra.starts3 ?? null);
        const ia = R[Math.max(idx(band(starts, M.startsPerDay)), idx(band(num(run.fire_escapes), M.escapes)))];
        const demand = R[Math.max(idx(large), idx(ia))];
        const steps = [];
        if (demand !== "Minimum") {
          // busy in the Southwest only (runs archived before Nov 19, 2026 get these columns from their snapshots)
          const K = M.capacity, cimtSw = num(run.imt_cimt_committed_sw), t3Sw = num(run.imt_t3_committed_sw), swa = num(run.crews_swa_total);
          const share = num(run.crews_committed_sw_share);
          if ((cimtSw !== null && cimtSw >= K.minCimtCommittedInSw) || (t3Sw !== null && K.minT3CommittedInSw && t3Sw >= K.minT3CommittedInSw) || (swa && share !== null && share >= K.minCrewShareCommittedInSw)) steps.push("capacity");
          const oRating = outlookRatingOf(run, cri), front = num(run.outlook_days13_avg), back = num(run.outlook_days47_avg), hr = num(run.outlook_high_risk_psa_days) || 0;
          if (M.outlook.alreadyHigh.includes(oRating) || (front !== null && back !== null && back - front >= M.outlook.risingBy && hr >= M.outlook.minHighRiskPsaDays)) steps.push("outlook");
        }
        fire = { rating: R[Math.min(4, idx(demand) + steps.length)], demand, large, ia, starts, steps };
      }
      const crewsRating = cri.includeT2IA === true && run.crews_rating_with_t2ia ? run.crews_rating_with_t2ia : cri.includeT2IA === false && run.crews_rating_without_t2ia ? run.crews_rating_without_t2ia : run.crews_rating;
      const ratings = { fire: fire.rating, imt: run.imt_rating || "Maximum", crews: crewsRating || "Maximum", outlook: outlookRatingOf(run, cri), danger: dangerRatingOf(run, cri) };
      let score = 0;
      const W = cri.bySeason && C.weightPresets[run.weights] ? C.weightPresets[run.weights].weights : cri.weights;
      for (const e of C.elements) score += r4((W[e.key] || 0) * ((e.inverted ? INV : MULT)[ratings[e.key]] ?? 0));
      score = r4(score);
      let pl = plLevel(score, cri.plLevels), held = false;
      if (cri.plGate && cri.plGate.maxPlWithoutFire && fire.rating === "Minimum" && pl > cri.plGate.maxPlWithoutFire) { pl = cri.plGate.maxPlWithoutFire; held = true; }
      return { pl, score, held, fire, ratings };
    }
    function outlookRatingOf(run, cri) {
      const avg = num(run.outlook_avg);
      if (avg === null) return run.outlook_rating || "Minimum";
      for (const b of cri.outlookBands) if (avg < (b.below ?? Infinity)) return b.rating;
      return "Maximum";
    }
    function dangerRatingOf(run, cri) {
      const p97 = num(run.erc_p97plus), p90 = num(run.erc_p90_96), p50 = num(run.erc_p50_89);
      if (p97 === null && p90 === null && p50 === null) return run.danger_rating || "Minimum";
      if (p97 >= cri.extremeCount) return "Extreme";
      if (p97 > 0) return "High";
      if (p90 > 0) return "Moderate";
      if (p50 > 0) return "Low";
      return "Minimum";
    }

    /* ---------- one record per day ---------- */
    // arch: { history, daily, raws, outlookPsa, ercyPsa, imported } as arrays of CSV row objects.
    // imported (published_pl.csv: date, pl): PLs published before this tool archived its own runs; used only
    // on days without an archived run, and only as "published" (they have no inputs to re-score).
    function buildDays(arch, cri) {
      const runs = {};
      for (const h of arch.history || []) {
        const d = h.run_date, cur = runs[d];
        if (!cur || (cur.run_slot !== "AM" && h.run_slot === "AM") || (cur.run_slot === h.run_slot && h.run_time < cur.run_time)) runs[d] = h;
      }
      for (const p of arch.imported || []) {
        const d = String(p.date || "").slice(0, 10), v = num(p.pl);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v && !runs[d]) runs[d] = { run_date: d, run_time: `${d}T08:00`, run_slot: "AM", pl: String(v), origin: "imported", source: p.source || "imported" };
      }
      const starts = Object.fromEntries((arch.daily || []).map((s) => [s.date, s]));
      const M = (cri || criteria()).fireActivityModel;
      const actuals = actualMap(arch);
      const ercByDate = {};
      for (const e of arch.ercyPsa || []) { const p = num(e.erc_pct); if (p !== null) (ercByDate[e.date] = ercByDate[e.date] || []).push(p); }
      const ercRating = (list) => { if (!list || !list.length) return null; const n97 = list.filter((p) => p >= 97).length;
        return n97 >= (cri || criteria()).extremeCount ? "Extreme" : n97 ? "High" : list.some((p) => p >= 90) ? "Moderate" : list.some((p) => p >= 50) ? "Low" : "Minimum"; };
      const all = [...new Set([...Object.keys(runs), ...Object.keys(starts)])].sort();
      if (!all.length) return [];
      const first = all[0], last = all[all.length - 1];
      const out = [];
      const tot = (d, k = "total") => num((starts[d] || {})[k]);
      for (let d = first; d <= last; d = addDays(d, 1)) {
        const nextN = (n, k) => { let s = 0, have = 0; for (let i = 1; i <= n; i++) { const v = tot(addDays(d, i), k); if (v !== null) { s += v; have++; } } return have === n ? s : null; };
        const prev3 = [1, 2, 3].map((i) => tot(addDays(d, -i))).filter((v) => v !== null);
        out.push({ date: d, run: runs[d] || null, starts: starts[d] || null,
          total: tot(d), lightning: tot(d, "lightning"), human: tot(d, "human"), acres: tot(d, "acres"),
          next7: nextN(7, "total"), next7Lightning: nextN(7, "lightning"), next7Acres: nextN(7, "acres"),
          starts3: prev3.length === 3 ? r1(mean(prev3)) : null });
        const last = out[out.length - 1];
        last.iaStarts = last.starts3 === null ? null : band(last.starts3, M.startsPerDay); // new-starts part of Fire Activity
        last.ercyDaily = ercRating(ercByDate[d]);
        last.actual = actuals[d] || null; // PSA ERCy rating from FEMS for that day (every day, not only run days)
      }
      return out;
    }
    const inRange = (days, from, to) => days.filter((d) => (!from || d.date >= from) && (!to || d.date <= to));

    /* ---------- the PL methods compared ---------- */
    const METHODS = {
      published: { label: "Published at the time", pl: (d) => num(d.run.pl), score: (d) => num(d.run.score) },
      model: { label: "Current criteria", pl: (d) => (d.run.origin === "imported" ? null : num(d.run.model_pl) ?? num(d.run.pl)), score: (d) => (d.run.origin === "imported" ? null : num(d.run.model_score) ?? num(d.run.score)) },
      shoulder: { label: "Old: shoulder season", pl: (d) => num(d.run.old_shoulder_pl), score: (d) => num(d.run.old_shoulder_score) },
      season: { label: "Old: fire season", pl: (d) => num(d.run.old_season_pl), score: (d) => num(d.run.old_season_score) },
      withT2IA: { label: "Type 2IA crews counted", pl: (d) => num(d.run.pl_with_t2ia), score: (d) => num(d.run.score_with_t2ia) },
      withoutT2IA: { label: "Type 2IA crews not counted", pl: (d) => num(d.run.pl_without_t2ia), score: (d) => num(d.run.score_without_t2ia) },
      actual: { label: "Actual (NICC / SWCC)", pl: (d) => (d.actual ? d.actual.pl : null), score: () => null },
    };
    function withTrial(days, cri) {
      return days.map((d) => (d.run && d.run.origin !== "imported" ? { ...d, trial: scoreRun(d.run, cri, { starts3: d.starts3 }) } : d));
    }
    const methodsFor = (hasTrial) => (hasTrial ? { ...METHODS, trial: { label: "Trial criteria", pl: (d) => d.trial && d.trial.pl, score: (d) => d.trial && d.trial.score } } : METHODS);

    /* Days at each PL and what followed, per method. */
    function plOutcomes(days, methods) {
      const runDays = days.filter((d) => d.run);
      const res = {};
      for (const [k, m] of Object.entries(methods)) {
        const by = { 1: [], 2: [], 3: [], 4: [], 5: [] };
        let n = 0;
        for (const d of runDays) { const p = m.pl(d); if (p) { by[p].push(d); n++; } }
        const rows = [1, 2, 3, 4, 5].map((p) => ({ pl: p, days: by[p].length, share: n ? by[p].length / n : 0, ...outcome(by[p]) }));
        res[k] = { label: m.label, n, rows, verdict: monotonic(rows, "next7", (r) => `PL${r.pl}`) };
      }
      return res;
    }
    function outcome(list) {
      const v = (k) => list.map((d) => d[k]).filter((x) => x !== null && x !== undefined);
      const withT3 = list.filter((d) => d.run && num(d.run.fire_complex) !== null);
      const t3 = withT3.map((d) => num(d.run.fire_complex) + (num(d.run.fire_t3) || 0));
      const withEsc = list.filter((d) => d.run && num(d.run.fire_escapes) !== null);
      return { sameDay: r1(mean(v("total"))), next7: r1(mean(v("next7"))), next7Acres: v("next7Acres").length ? Math.round(mean(v("next7Acres"))) : null,
        largeFires: t3.length ? r1(mean(t3)) : null, escapeDays: withEsc.length ? withEsc.filter((d) => num(d.run.fire_escapes) > 0).length / withEsc.length : null,
        maxNext7: v("next7").length ? Math.max(...v("next7")) : null };
    }
    /* Does the outcome rise with the level? Compares levels with 3+ days. */
    function monotonic(rows, key, name) {
      const ok = rows.filter((r) => r.days >= 3 && r[key] !== null);
      if (ok.length < 2) return { status: "few", text: "Not enough days at different levels yet to judge (needs 3+ days at two or more levels)." };
      const bad = [];
      for (let i = 1; i < ok.length; i++) if (ok[i][key] < ok[i - 1][key]) bad.push(`${name(ok[i])} (${ok[i][key]}) was followed by less fire than ${name(ok[i - 1])} (${ok[i - 1][key]})`);
      return bad.length ? { status: "warn", text: bad.join("; ") + "." } : { status: "ok", text: `Each higher level was followed by more new starts in the next 7 days (${ok.map((r) => `${name(r)} ${r[key]}`).join(" → ")}).` };
    }

    /* Each element's rating vs what followed. */
    const ELEMENTS = [
      { key: "ia", label: "New-starts load (3-day average, part of Fire Activity)", all: true, col: (d) => d.iaStarts },
      { key: "ercyDaily", label: "PSA ERCy from FEMS (every day)", all: true, col: (d) => d.ercyDaily },
      { key: "fire", label: "Fire Activity", col: (d, t) => (t ? d.trial && d.trial.ratings.fire : d.run.model_fire_rating || d.run.fire_rating) },
      { key: "outlook", label: "7-Day trend", col: (d, t) => (t ? d.trial && d.trial.ratings.outlook : d.run.outlook_rating) },
      { key: "danger", label: "PSA ERCy", col: (d, t) => (t ? d.trial && d.trial.ratings.danger : d.run.danger_rating) },
      { key: "imt", label: "IMT availability", col: (d) => d.run.imt_rating, inverted: true },
      { key: "crews", label: "Crew availability", col: (d) => d.run.crews_rating, inverted: true },
    ];
    function elementOutcomes(days, useTrial) {
      const runDays = days.filter((d) => d.run);
      return ELEMENTS.map((e) => {
        const by = {};
        const pool = e.all ? days : runDays.filter((d) => d.run.origin !== "imported");
        for (const d of pool) { const r = e.col(d, useTrial); if (r) (by[r] = by[r] || []).push(d); }
        const order = e.inverted ? [...ORDER].reverse() : ORDER;
        const rows = order.filter((r) => by[r]).map((r) => ({ rating: r, days: by[r].length, share: by[r].length / (pool.length || 1), ...outcome(by[r]) }));
        const notes = [];
        const top = rows.reduce((a, r) => (r.share > (a ? a.share : 0) ? r : a), null);
        if (top && pool.length >= 20 && top.share >= 0.85) notes.push({ status: "warn", text: `${top.rating} on ${Math.round(top.share * 100)}% of days: this element hardly moves over the range, so it adds little to the PL. ${e.inverted ? "" : "Its thresholds may be set too high (or too low) for this range."}` });
        if (!e.inverted) { const m = monotonic(rows.map((r) => ({ ...r, pl: r.rating })), "next7", (r) => r.rating); notes.push(m); }
        return { ...e, rows, notes };
      });
    }

    /* Fire Activity inputs over the range vs the thresholds in use. */
    function pct(sorted, p) { if (!sorted.length) return null; const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return r1(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)); }
    function thresholds(days, cri) {
      const M = cri.fireActivityModel;
      const s3 = days.map((d) => (d.run && num(d.run.fire_starts_avg3) !== null ? num(d.run.fire_starts_avg3) : d.starts3)).filter((v) => v !== null).sort((a, b) => a - b);
      const esc = days.filter((d) => d.run && num(d.run.fire_escapes) !== null).map((d) => num(d.run.fire_escapes)).sort((a, b) => a - b);
      const daily = days.map((d) => d.total).filter((v) => v !== null).sort((a, b) => a - b);
      const bandCount = (vals, bands) => { const c = Object.fromEntries(R.map((r) => [r, 0])); for (const v of vals) c[band(v, bands)]++; return c; };
      const steps = { capacity: 0, outlook: 0, held: 0, heldStarts: [], runs: 0 };
      for (const d of days) {
        if (!d.trial && !d.run) continue;
        const t = d.trial || null;
        steps.runs += d.run ? 1 : 0;
        if (t) { if (t.fire.steps && t.fire.steps.includes("capacity")) steps.capacity++; if (t.fire.steps && t.fire.steps.includes("outlook")) steps.outlook++; if (t.held) { steps.held++; if (d.next7 !== null) steps.heldStarts.push(d.next7); } }
        else if (d.run) { if (d.run.fire_capacity_step === "yes") steps.capacity++; if (d.run.fire_outlook_step === "yes") steps.outlook++; if (d.run.model_held === "yes" || d.run.pl_held_no_fire === "yes") { steps.held++; if (d.next7 !== null) steps.heldStarts.push(d.next7); } }
      }
      const pctl = (a) => ({ n: a.length, p50: pct(a, 0.5), p75: pct(a, 0.75), p90: pct(a, 0.9), p97: pct(a, 0.97), max: a.length ? a[a.length - 1] : null });
      // suggestion: put the Low/Moderate/High/Maximum lines at the 50th/75th/90th/97th percentile of days that had fire
      const fireDays = s3.filter((v) => v > 0);
      const sug = fireDays.length >= 30 ? [0.5, 0.75, 0.9, 0.97].map((p) => Math.max(1, Math.round(pct(fireDays, p)))) : null;
      return { startsAvg3: pctl(s3), dailyStarts: pctl(daily), escapes: pctl(esc), startsBands: bandCount(s3, M.startsPerDay), escapeBands: bandCount(esc, M.escapes),
        current: M.startsPerDay.map((b) => b.atLeast), currentEsc: M.escapes.map((b) => b.atLeast), suggested: sug, fireDayCount: fireDays.length, steps };
    }

    /* Per PSA-day checks: 7-Day Day-1 level and ERCy percentile vs starts in that PSA (that day + next 2 days). */
    function psaStarts(arch) {
      const m = {};
      for (const s of arch.daily || []) for (const p of C.psas) { const v = num(s[`psa_${p.ercId}`]); if (v !== null) (m[s.date] = m[s.date] || {})[p.ercId] = v; }
      return m;
    }
    function psaWindow(m, date, psa, n) { let s = 0; for (let i = 0; i < n; i++) { const day = m[addDays(date, i)]; if (!day) return null; s += day[psa] || 0; } return s; }
    function psaTable(rows, key) {
      return rows.map((r) => ({ level: r.level, psaDays: r.list.length, anyStart: r.list.length ? r.list.filter((v) => v > 0).length / r.list.length : null,
        avg: r1(mean(r.list)), busy: r.list.length ? r.list.filter((v) => v >= 3).length / r.list.length : null, [key]: true }));
    }
    function outlookCheck(arch, from, to) {
      const m = psaStarts(arch), lv = { 1: [], 2: [], 3: [], 4: [] };
      for (const o of arch.outlookPsa || []) {
        if ((from && o.date < from) || (to && o.date > to)) continue;
        const l = num(o.d1); if (!l) continue;
        const v = psaWindow(m, o.date, o.psa, 3); if (v !== null) lv[Math.round(l)].push(v);
      }
      const rows = psaTable([1, 2, 3, 4].map((l) => ({ level: l, list: lv[l] })), "outlook");
      return { rows, verdict: monotonic(rows.map((r) => ({ ...r, days: r.psaDays })), "avg", (r) => `level ${r.level}`).text.replace(/new starts in the next 7 days/, "starts in that PSA over 3 days") };
    }
    function ercyCheck(arch, from, to) {
      const m = psaStarts(arch), bins = [["under 50th", (v) => v < 50], ["50th–89th", (v) => v < 90], ["90th–96th", (v) => v < 97], ["97th+", () => true]];
      const lists = bins.map(() => []);
      for (const e of arch.ercyPsa || []) {
        if ((from && e.date < from) || (to && e.date > to)) continue;
        const p = num(e.erc_pct); if (p === null) continue;
        const v = psaWindow(m, e.date, e.psa, 3); if (v === null) continue;
        lists[bins.findIndex(([, f]) => f(p))].push(v);
      }
      const rows = psaTable(bins.map(([l], i) => ({ level: l, list: lists[i] })), "ercy");
      return { rows, verdict: monotonic(rows.map((r) => ({ ...r, days: r.psaDays })), "avg", (r) => r.level).text.replace(/new starts in the next 7 days/, "starts in that PSA over 3 days") };
    }
    function weatherCheck(arch, from, to) {
      const m = psaStarts(arch);
      const rh = [["under 10%", (v) => v < 10], ["10–14%", (v) => v < 15], ["15–24%", (v) => v < 25], ["25%+", () => true]];
      const lists = rh.map(() => []), wind = { yes: [], no: [] }, rain = { yes: [], no: [] };
      for (const w of arch.raws || []) {
        if ((from && w.date < from) || (to && w.date > to)) continue;
        const v = psaWindow(m, addDays(w.date, 1), w.psa, 2); // starts the next 2 days
        if (v === null) continue;
        const low = num(w.lowest_rh); if (low !== null) lists[rh.findIndex(([, f]) => f(low))].push(v);
        (w.wind_event === "yes" ? wind.yes : wind.no).push(v);
        (num(w.wetting_rain_stations) > 0 ? rain.yes : rain.no).push(v);
      }
      const t = (label, list) => ({ level: label, psaDays: list.length, avg: r1(mean(list)), anyStart: list.length ? list.filter((x) => x > 0).length / list.length : null });
      return { rh: rh.map(([l], i) => t(l, lists[i])), wind: [t("wind event", wind.yes), t("no wind event", wind.no)], rain: [t("wetting rain", rain.yes), t("no wetting rain", rain.no)] };
    }

    /* Days where the PL and what followed disagreed most. */
    function misses(days, plOf) {
      const runDays = days.filter((d) => d.run && d.next7 !== null && plOf(d));
      if (runDays.length < 10) return { low: [], high: [], cut: null };
      const sorted = runDays.map((d) => d.next7).sort((a, b) => a - b);
      const hi = pct(sorted, 0.9), lo = pct(sorted, 0.25);
      const low = runDays.filter((d) => d.next7 >= hi && hi > 0 && plOf(d) <= 2).sort((a, b) => b.next7 - a.next7).slice(0, 15);
      const high = runDays.filter((d) => d.next7 <= lo && plOf(d) >= 3).sort((a, b) => a.next7 - b.next7).slice(0, 15);
      return { low, high, cut: { hi, lo } };
    }
    /* PL changes and quick reversals (up then back within 2 days). */
    function stability(days, plOf) {
      const seq = days.filter((d) => d.run && plOf(d)).map((d) => ({ date: d.date, pl: plOf(d) }));
      let changes = 0, flips = 0;
      for (let i = 1; i < seq.length; i++) {
        if (seq[i].pl !== seq[i - 1].pl) { changes++; if (seq[i + 1] && seq[i + 1].pl === seq[i - 1].pl) flips++; if (seq[i + 2] && seq[i + 1].pl === seq[i].pl && seq[i + 2].pl === seq[i - 1].pl) flips++; }
      }
      return { changes, flips, days: seq.length, highest: seq.length ? Math.max(...seq.map((s) => s.pl)) : null };
    }

    /* Pearson correlation of score with starts over the next 7 days. */
    function correlation(days, scoreOf) {
      const p = days.filter((d) => d.run && d.next7 !== null && scoreOf(d) !== null);
      if (p.length < 10) return null;
      const xs = p.map(scoreOf), ys = p.map((d) => d.next7);
      const mx = mean(xs), my = mean(ys);
      let c = 0, vx = 0, vy = 0;
      for (let i = 0; i < xs.length; i++) { c += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; vy += (ys[i] - my) ** 2; }
      return vx && vy ? Math.round((c / Math.sqrt(vx * vy)) * 100) / 100 : null;
    }

    /* ---------- forecast vs actual ----------
       forecasts: forecast_pl.csv rows; actual: actual_pl.csv rows (NICC/SWCC); imported: published_pl.csv rows.
       For each lead (0–4 days): forecasts with a known actual, exact hits, within one level, average error
       (forecast − actual: + = forecast too high), and the same for "no change" (the actual PL on the day the
       forecast was made, carried forward), which a useful forecast should beat. */
    function actualMap(arch) {
      const m = {};
      for (const p of arch.imported || []) if (num(p.pl)) m[String(p.date).slice(0, 10)] = { pl: num(p.pl), source: "published" };
      for (const a of arch.actual || []) if (num(a.pl)) m[String(a.date).slice(0, 10)] = { pl: num(a.pl), source: a.source || "actual" };
      return m;
    }
    function forecastCheck(arch, from, to) {
      const A = actualMap(arch);
      const by = {};
      const misses = [];
      for (const f of arch.forecasts || []) {
        const t = f.target_date, lead = num(f.lead_days), pl = num(f.pl);
        if (!t || lead === null || pl === null || (from && t < from) || (to && t > to)) continue;
        const a = A[t]; if (!a) continue;
        const b = (by[lead] = by[lead] || { lead, n: 0, exact: 0, within1: 0, err: 0, absErr: 0, pn: 0, pexact: 0, perr: 0 });
        b.n++; if (pl === a.pl) b.exact++; if (Math.abs(pl - a.pl) <= 1) b.within1++; b.err += pl - a.pl; b.absErr += Math.abs(pl - a.pl);
        const base = A[String(f.issued_date || f.issued || "").slice(0, 10)];
        if (base) { b.pn++; if (base.pl === a.pl) b.pexact++; b.perr += Math.abs(base.pl - a.pl); }
        if (pl !== a.pl) misses.push({ issued: f.issued, target: t, lead, forecast: pl, actual: a.pl, fire: f.fire, outlook: f.outlook, danger: f.danger });
      }
      const rows = Object.values(by).sort((x, y) => x.lead - y.lead).map((b) => ({ lead: b.lead, n: b.n, exact: b.exact / b.n, within1: b.within1 / b.n,
        bias: Math.round((b.err / b.n) * 100) / 100, mae: Math.round((b.absErr / b.n) * 100) / 100,
        persistExact: b.pn ? b.pexact / b.pn : null, persistMae: b.pn ? Math.round((b.perr / b.pn) * 100) / 100 : null }));
      return { rows, misses: misses.sort((x, y) => y.target.localeCompare(x.target) || x.lead - y.lead).slice(0, 40), actualDays: Object.keys(A).length };
    }

    return { criteria, setSeason, scoreRun, buildDays, forecastCheck, actualMap, inRange, withTrial, methodsFor, plOutcomes, elementOutcomes, thresholds, outlookCheck, ercyCheck, weatherCheck, misses, stability, correlation, addDays, METHODS };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeReview;
  else root.PL_REVIEW = makeReview(root.PL_CONFIG);
})(typeof window !== "undefined" ? window : globalThis);
