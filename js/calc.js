/*
 * SWA Preparedness Level — calculation engine.
 * Pure functions: state in, numbers and ratings out. No DOM access, so the same
 * code runs in the browser, in Node tests, and in any future automated pipeline.
 */
(function (root) {
  "use strict";

  function makeCalc(C) {
    const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
    const num = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : null;
    };

    /* ---------- Fire Activity ---------- */
    const R = ["Minimum", "Low", "Moderate", "High", "Maximum"];
    const idx = (r) => Math.max(0, R.indexOf(r));
    const maxR = (...rs) => R[Math.max(...rs.map(idx))];
    const band = (v, bands) => { let r = "Minimum"; for (const b of bands) if (v !== null && v >= b.atLeast) r = b.rating; return r; };
    /* Large-fire rule from the spreadsheet guidance: active T3+ incidents, of which T2+/complex. */
    function largeFireRating(complex, t3) {
      const total = complex + t3;
      for (const lvl of C.fireActivity) if (total <= lvl.maxIncidents && complex <= lvl.maxComplex) return lvl.rating;
      return "Maximum";
    }
    /* Average new starts per day over the last 3 complete days in the fire-start pull. */
    function startsAverage(fireStarts) {
      const d = (fireStarts && fireStarts.daily) || {};
      const days = Object.keys(d).sort().filter((k) => !fireStarts.to || k <= fireStarts.to).slice(-3);
      return days.length ? round(days.reduce((a, k) => a + (num(d[k].total) || 0), 0) / days.length, 1) : null;
    }
    /*
     * Fire Activity = how much work is on the ground and how hard it is to meet it.
     *  demand   = the higher of the large-fire rating and the initial-attack rating
     *             (IA = the higher of the 3-day new-start average and escapes);
     *  +1 step  if IMTs or crews are busy in the Southwest (on Southwest incidents; out of area doesn't count);
     *  +1 step  if the 7-day outlook is rising or already High/Maximum.
     * The steps only apply when demand is above Minimum: no fire on the ground stays Minimum.
     * ctx = { imt, crews, outlook, fireStarts } summaries; fire.override wins when a person picked a rating.
     */
    function fireActivity(fire, ctx = {}) {
      const M = C.fireActivityModel;
      const complex = num(fire.complex) || 0;
      const t3 = num(fire.t3) || 0;
      const total = complex + t3;
      const large = largeFireRating(complex, t3);
      const startsAvg = num(fire.startsAvg3) ?? startsAverage(ctx.fireStarts);
      const escapes = num(fire.escapes);
      const startsRating = band(startsAvg, M.startsPerDay);
      const escapeRating = band(escapes, M.escapes);
      const ia = maxR(startsRating, escapeRating);
      const demand = maxR(large, ia);
      const steps = [];
      if (demand !== "Minimum") {
        // Strained = busy in the Southwest: only teams and crews working Southwest incidents count. Teams and crews
        // out of area, off rotation or unavailable for the season don't raise the PL.
        const im = ctx.imt, cr = ctx.crews, K = M.capacity;
        const cap = [];
        if (im && im.commCimtSw >= K.minCimtCommittedInSw) cap.push(`${im.commCimtSw} CIMT${im.commCimtSw === 1 ? "" : "s"} on Southwest incidents`);
        if (im && K.minT3CommittedInSw && im.commT3Sw >= K.minT3CommittedInSw) cap.push(`${im.commT3Sw} Type 3 teams on Southwest incidents`);
        if (cr && cr.swaTotal && cr.committedSwShare >= K.minCrewShareCommittedInSw) cap.push(`${Math.round(cr.committedSwShare * 100)}% of crews on Southwest incidents`);
        if (cap.length) steps.push({ kind: "capacity", why: `resources strained: ${cap.join(", ")}` });
        const o = ctx.outlook;
        if (o && o.daily && o.daily.length) {
          // first 3 days vs the rest (Days 1–3 vs 4–7 for a full week; fewer days later in a forecast)
          const cut = Math.min(3, Math.ceil(o.daily.length / 2));
          const avgOf = (list) => (list.length ? list.reduce((a, d) => a + d.score, 0) / list.length : NaN);
          const front = avgOf(o.daily.slice(0, cut)), back = avgOf(o.daily.slice(cut));
          const highDays = o.daily.reduce((a, d) => a + d.counts[4], 0);
          if (M.outlook.alreadyHigh.includes(o.rating)) steps.push({ kind: "outlook", why: `7-day outlook already ${o.rating}` });
          else if (Number.isFinite(back) && back - front >= M.outlook.risingBy && highDays >= M.outlook.minHighRiskPsaDays)
            steps.push({ kind: "outlook", why: `7-day outlook rising (${round(front, 1)} → ${round(back, 1)}) with ${highDays} high-risk PSA-days` });
        }
      }
      const computed = R[Math.min(4, idx(demand) + steps.length)];
      const mode = fire.override ? "override" : M.enabled ? (fire.fetchedAt ? "auto" : "calculated") : "manual";
      const rating = mode === "override" ? fire.override : mode === "manual" ? fire.rating || "Minimum" : computed;
      return { rating, mode, computed, complex, t3, total, suggested: large, large, startsAvg, startsRating, escapes, escapeRating, ia, demand, steps };
    }

    /* ---------- IMT Availability ---------- */
    /* Is a committed team or crew working in the Southwest? From its incident dispatch/GACC and state:
       a Southwest dispatch center or SWCC → yes; another GACC → no; AZ or NM → yes; another state (other than
       TX/OK, which are partly in the Southwest) → no. With nothing to go on it counts as in the Southwest. */
    const SW_DISPATCH = new Set(C.swDispatchCenters || ["SWCC", "ADC", "ABC", "FDC", "PHC", "PDC", "SDC", "SFC", "TDC", "WDC"]);
    const STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
    function inSouthwest(x) {
      const disp = String(x.incDisp || x.location || "").toUpperCase(), st = String(x.incState || "").toUpperCase().replace(/^US-/, "").trim();
      const codes = disp.split(/[^A-Z]+/).filter(Boolean);
      if (codes.some((c) => SW_DISPATCH.has(c) || /^(SW|SWA|SWCC)$/.test(c))) return { sw: true, known: true };
      if (codes.some((c) => /^(AICC|EACC|GBCC|ONCC|OSCC|NRCC|NWCC|RMCC|SACC|NICC)$/.test(c))) return { sw: false, known: true };
      // "ID-BDC", "AZ-PHC": the state in front of a dispatch code
      const ds = (disp.match(/\b([A-Z]{2})-[A-Z]{3}\b/) || [])[1];
      for (const s0 of [ds, st]) {
        if (!s0 || !STATES.has(s0)) continue;
        if (/^(AZ|NM)$/.test(s0)) return { sw: true, known: true };
        if (!/^(TX|OK)$/.test(s0)) return { sw: false, known: true };
      }
      return { sw: true, known: false };
    }
    function imtSummary(imts) {
      const group = (code) => (C.imtStatuses.find((s) => s.code === code) || {}).group;
      const isCimt = (t) => t === "CIMT" || t === "OOA CIMT";
      const rows = { total: imts.length, cimt: 0, t3: 0, other: 0,
        availCimt: 0, availT3: 0, availAll: 0, commCimt: 0, commT3: 0,
        commCimtSw: 0, commT3Sw: 0, commOut: 0, commOutCimt: 0, commOutT3: 0, commNoLocation: 0 };
      for (const t of imts) {
        const g = group(t.status);
        if (isCimt(t.type)) rows.cimt++; else if (String(t.type) === "3") rows.t3++; else rows.other++;
        if (g === "available") {
          rows.availAll++;
          if (isCimt(t.type)) rows.availCimt++;
          if (String(t.type) === "3") rows.availT3++;
        }
        if (g === "committed") {
          if (isCimt(t.type)) rows.commCimt++;
          if (String(t.type) === "3") rows.commT3++;
          const w = inSouthwest(t);
          if (!w.known) rows.commNoLocation++;
          if (!w.sw) { rows.commOut++; if (isCimt(t.type)) rows.commOutCimt++; if (String(t.type) === "3") rows.commOutT3++; }
          else { if (isCimt(t.type)) rows.commCimtSw++; if (String(t.type) === "3") rows.commT3Sw++; }
        }
      }
      // Teams committed out of area left out (C.imtAvailability.outOfAreaLeftOut): the available teams are scaled
      // to the full roster, so 1 of the 2 CIMTs left in the Southwest available rates like 2 of 4.
      const scale = (avail, all, out) => (!out ? avail : all - out > 0 ? Math.round((avail * all) / (all - out)) : all);
      const leaveOut = (C.imtAvailability || {}).outOfAreaLeftOut;
      rows.ratedCimt = leaveOut ? scale(rows.availCimt, rows.cimt, rows.commOutCimt) : rows.availCimt;
      rows.ratedT3 = leaveOut ? scale(rows.availT3, rows.t3, rows.commOutT3) : rows.availT3;
      // IMT's!D43
      let rating;
      if (rows.ratedCimt === 0) rating = "Minimum";
      else if (rows.ratedCimt <= 2) rating = "Low";
      else if (rows.ratedCimt <= 3) rating = "Moderate";
      else if (rows.ratedT3 >= 4) rating = "Maximum";
      else rating = "High";
      // IMT's!D26 (commitment, shown for reference)
      let commitment;
      if (rows.commCimt >= 5) commitment = "Maximum";
      else if (rows.commCimt >= 3) commitment = "High";
      else if (rows.commCimt > 0) commitment = "Moderate";
      else if (rows.commT3 > 0) commitment = "Low";
      else commitment = "Minimum";
      return { ...rows, rating, commitment };
    }

    /* ---------- Crew Availability ---------- */
    function crewRatio(ratio) {
      for (const b of C.crewAvailability.bands) {
        if (b.atLeast !== undefined ? ratio >= b.atLeast : ratio > b.above) return b.rating;
      }
      return "Minimum";
    }
    function crewCounts(crews) {
      const out = {};
      for (const s of C.crewStatuses) out[s.code] = 0;
      let prepoSWCC = 0, prepoUnit = 0;
      for (const c of crews) {
        if (out[c.status] === undefined) continue;
        out[c.status]++;
        if (c.status === "P") {
          if ((c.location || "").toUpperCase() === C.prepoAvailableLocation) prepoSWCC++; else prepoUnit++;
        }
      }
      const groupOf = (code) => (C.crewStatuses.find((s) => s.code === code) || {}).group;
      const g = {};
      for (const code in out) { const k = groupOf(code); g[k] = (g[k] || 0) + out[code]; }
      return { byStatus: out, byGroup: g, prepoSWCC, prepoUnit,
        available: (g.available || 0), committed: out.C || 0 };
    }
    /* t2ia: SWA Type 2IA crews; includeT2IA: count them (available ones on top, all of them in the total). */
    /* The Southwest crew pool: SWA crews (plus Type 2IA crews when counted) minus those committed out of area.
       20 crews with 5 out of area → a pool of 15; 3 committed in the Southwest → 3 of 15 (20%), not 8 of 20.
       Both crew numbers use this pool: availability (available ÷ pool) and the share committed in the Southwest.
       t2ia: SWA Type 2IA crews; includeT2IA: count them. */
    function crewSummary(crews, ooaCrews, t2ia = [], includeT2IA = false) {
      const swa = crewCounts(crews);
      const ooa = crewCounts(ooaCrews || []);
      const t2 = crewCounts(t2ia || []);
      const t2Avail = t2.available + t2.prepoSWCC;
      const total = crews.length + (includeT2IA ? (t2ia || []).length : 0);
      const committedOut = (swa.byStatus["C-O"] || 0) + (includeT2IA ? t2.byStatus["C-O"] || 0 : 0);
      const pool = Math.max(0, total - committedOut);
      const denom = pool || 1;
      const swaAvail = swa.available + swa.prepoSWCC;
      const ooaAvail = (C.crewAvailability.includeOOAAvailable ? ooa.available : 0) + ooa.prepoSWCC;
      const totalAvail = swaAvail + ooaAvail + (includeT2IA ? t2Avail : 0);
      const ratio = pool ? totalAvail / denom : 0;
      // crews working Southwest incidents: SWA crews committed in SWA (C), out-of-area crews here that are committed,
      // and (when counted) Type 2IA crews committed
      const committedSw = (swa.byStatus.C || 0) + (ooa.byStatus.C || 0) + (includeT2IA ? t2.byStatus.C || 0 : 0);
      const committedSwShare = pool ? committedSw / denom : 0;
      return { committedSw, committedOut, committedSwShare, pool, total,
        swa, ooa, t2ia: t2, swaTotal: crews.length, ooaTotal: (ooaCrews || []).length, t2iaTotal: (t2ia || []).length, t2iaAvail: t2Avail, includeT2IA: Boolean(includeT2IA),
        swaAvail, ooaAvail, totalAvail, ratio,
        swaRating: crewRatio(pool ? swaAvail / denom : 0),
        rating: crewRatio(ratio),
        commitRatio: pool ? (swa.byStatus.C || 0) / denom : 0,
        commitment: crewRatio(pool ? (swa.byStatus.C || 0) / denom : 0),
      };
    }

    /* ---------- 7-Day Significant Fire Potential ---------- */
    function outlookRating(score) {
      for (const b of C.outlook.bands) if (score < b.below) return b.rating;
      return "Maximum";
    }
    /* outlook.values: Day 1–7 level per PSA. A shorter list (later days of a forecast) averages the days it has. */
    function outlookSummary(outlook) {
      const lens = Object.values(outlook.values || {}).map((a) => (a || []).length).filter((n) => n > 0);
      const days = lens.length ? Math.min(7, Math.max(...lens)) : 7;
      const daily = [];
      for (let d = 0; d < days; d++) {
        const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
        let score = 0, n = 0;
        for (const p of C.psas) {
          const v = num((outlook.values[p.id] || [])[d]);
          if (v === null) continue;
          const lvl = Math.max(1, Math.min(4, Math.round(v)));
          counts[lvl]++; score += lvl; n++;
        }
        daily.push({ counts, score, n, rating: outlookRating(score) });
      }
      const avg = daily.reduce((a, d) => a + d.score, 0) / days;
      return { daily, avg: round(avg, 2), rating: outlookRating(avg) };
    }

    /* ---------- PSA ERCy ---------- */
    function dangerSummary(danger) {
      const bins = { below50: 0, p50to89: 0, p90to96: 0, p97plus: 0, missing: 0 };
      const biBins = { below50: 0, p50to89: 0, p90to96: 0, p97plus: 0 };
      const binOf = (v, b) => {
        if (v < 50) b.below50++; else if (v < 90) b.p50to89++; else if (v < 97) b.p90to96++; else b.p97plus++;
      };
      for (const p of C.psas) {
        const r = danger.rows[p.ercId] || {};
        const e = num(r.ercPct);
        if (e === null) bins.missing++; else binOf(e, bins);
        const b = num(r.biPct);
        if (b !== null) binOf(b, biBins);
      }
      let rating;
      if (bins.p97plus >= C.danger.extremeCount) rating = "Extreme";
      else if (bins.p97plus > 0) rating = "High";
      else if (bins.p90to96 > 0) rating = "Moderate";
      else if (bins.p50to89 > 0) rating = "Low";
      else rating = "Minimum";
      return { bins, biBins, above50: bins.p50to89 + bins.p90to96 + bins.p97plus, count: C.psas.length, rating };
    }

    /* ---------- PL ---------- */
    function plLevel(score) {
      let pl = 1;
      for (const l of C.plLevels) if (score >= l.min) pl = l.pl;
      return pl;
    }
    function weightsFor(state) {
      if (state.preset && state.preset !== "custom" && C.weightPresets[state.preset]) {
        return { ...C.weightPresets[state.preset].weights };
      }
      return { ...C.weightPresets[C.defaultPreset].weights, ...(state.weights || {}) };
    }
    /* opts: { weights, fireRating, gate } — used to recompute with the old method for comparison. */
    function compute(state, opts = {}) {
      const imt = imtSummary(state.imts || []);
      const includeT2IA = opts.includeT2IA ?? (state.includeT2IA ?? C.crewAvailability.includeT2IA);
      const crews = crewSummary(state.crews || [], state.ooaCrews || [], state.t2iaCrews || [], includeT2IA);
      const outlook = outlookSummary(state.outlook || { values: {} });
      const danger = dangerSummary(state.danger || { rows: {} });
      const fire = fireActivity(state.fire || {}, { imt, crews, outlook, fireStarts: state.fireStarts });
      if (opts.fireRating) fire.rating = opts.fireRating;
      const weights = opts.weights ? { ...opts.weights } : weightsFor(state);
      const ratings = { fire: fire.rating, imt: imt.rating, crews: crews.rating,
        outlook: outlook.rating, danger: danger.rating };
      const elements = C.elements.map((e) => {
        const table = e.inverted ? C.invertedMultipliers : C.multipliers;
        const mult = table[ratings[e.key]] ?? 0;
        const weight = num(weights[e.key]) || 0;
        return { ...e, rating: ratings[e.key], weight, multiplier: mult, contribution: round(weight * mult) };
      });
      const score = round(elements.reduce((a, e) => a + e.contribution, 0));
      const weightTotal = round(elements.reduce((a, e) => a + e.weight, 0));
      // PL3 and above need fire on the ground: without it the PL is held at C.plGate.maxPlWithoutFire.
      let pl = plLevel(score), held = false;
      const gate = opts.gate ?? true;
      if (gate && C.plGate && fire.rating === "Minimum" && pl > C.plGate.maxPlWithoutFire) { pl = C.plGate.maxPlWithoutFire; held = true; }
      return { fire, imt, crews, outlook, danger, weights, weightTotal, elements, score, pl, scorePl: plLevel(score), held };
    }
    /* The PL the old spreadsheet method would give (seasonal weights, large-fire rule only, no gate). */
    function oldMethod(state, preset) {
      const r0 = compute(state, { gate: false });
      return compute(state, { weights: C.weightPresets[preset].weights, fireRating: r0.fire.large, gate: false });
    }

    /*
     * PL forecast for today and the next 6 days, from the 7-Day outlook issued this morning:
     * Day 1 is today, Day 2 tomorrow … Day 7 six days out.
     *  • 7-Day part: for each day, the outlook from that day to Day 7, the same way today's PL looks at
     *    the whole week (Day 1 uses Days 1–7, Day 2 uses Days 2–7 … Day 7 uses Day 7 only).
     *  • ERC/BI: state.forecastDanger[date] (FEMS forecast ERC/BI for the 40 stations, worked out like the
     *    observed values) when the job found it, otherwise the latest observed values.
     *  • Fire Activity inputs, crews and IMTs: today's (their +1 steps are re-checked for each day).
     * If the outlook in hand was issued before today, only the days it still covers are forecast.
     */
    const addDaysIso = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
    function forecast(state, { days = 6, today, opts = {} } = {}) {
      const o = state.outlook || { values: {} };
      const base = today || o.startDate || String((state.meta && state.meta.asOf) || "").slice(0, 10);
      const out = [];
      const fd = state.forecastDanger || {};
      for (let k = 0; k <= days; k++) {
        const date = addDaysIso(base, k);
        const off = o.startDate ? daysBetween(o.startDate, date) : k; // 0 = the outlook's Day 1
        if (off > 6) break;                                            // past the outlook's Day 7
        const values = {};
        for (const [pid, arr] of Object.entries(o.values || {})) values[pid] = (arr || []).slice(Math.max(0, off));
        const st = { ...state, outlook: { ...o, values } };
        let dangerSource = `observed ${(state.danger && state.danger.date) || ""}`.trim();
        if (k > 0 && fd[date] && fd[date].rows) { st.danger = { ...state.danger, ...fd[date], date }; dangerSource = fd[date].source || "FEMS forecast"; }
        const r = compute(st, opts);
        out.push({ lead: k, date, outlookDay: off + 1, outlookIssued: o.startDate || "", pl: r.pl, score: r.score, held: r.held,
          ratings: Object.fromEntries(r.elements.map((e) => [e.key, e.rating])), outlookAvg: r.outlook.avg, dangerSource,
          dayLevel: ((r.outlook.daily || [])[0] || {}).rating || "" });
      }
      return out;
    }

    /* Which criteria made a PL: the label set in js/config.js (criteriaVersion) and a fingerprint of every
       setting that changes the PL (weights, PL lines, PL2 hold, Fire Activity thresholds, 7-Day bands, ERCy rule,
       crew and IMT rules, plus the ERC/BI breakpoints passed in), so a change can't go unrecorded. */
    function criteriaFingerprint(breakpoints) {
      const pick = { w: Object.fromEntries(Object.entries(C.weightPresets).map(([k, p]) => [k, p.weights])), imtRule: C.imtAvailability || null, pl: C.plLevels, gate: C.plGate, fa: C.fireActivity, fam: C.fireActivityModel,
        ob: C.outlook.bands, dg: C.danger, crew: C.crewAvailability, cs: C.crewStatuses, is: C.imtStatuses, mult: C.multipliers, inv: C.invertedMultipliers,
        bp: breakpoints || null, big: (C.autoData.fireActivity || {}) };
      const text = JSON.stringify(pick, (k, v) => (v === Infinity ? "Inf" : v));
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return h.toString(16).padStart(8, "0");
    }
    function criteriaVersion(breakpoints) {
      const v = C.criteriaVersion || {};
      return { label: v.label || "", fingerprint: criteriaFingerprint(breakpoints) };
    }

    /* The PL only changes when `runsToAgree` scheduled runs in a row calculate the same new PL.
       prev: the stored { pl, since, pending: { pl, since, runs } } (or nothing on a first run). */
    function confirmPl(prev, calcPl, { scheduled = true, now = "", runsToAgree = (C.plConfirm || {}).runsToAgree || 2, scheduledOnly = (C.plConfirm || {}).scheduledOnly !== false } = {}) {
      const pc = prev && prev.pl ? { ...prev, pending: prev.pending ? { ...prev.pending } : null } : { pl: calcPl, since: now, pending: null };
      let changed = false;
      if (calcPl === pc.pl) pc.pending = null;
      else {
        if (!pc.pending || pc.pending.pl !== calcPl) pc.pending = { pl: calcPl, since: now, runs: 0 };
        if (scheduled || !scheduledOnly) pc.pending.runs++;
        if (pc.pending.runs >= runsToAgree) { pc.pl = calcPl; pc.since = now; pc.pending = null; changed = true; }
      }
      pc.calculated = calcPl; pc.checked = now;
      return { ...pc, changed };
    }

    return { compute, oldMethod, forecast, criteriaFingerprint, criteriaVersion, confirmPl, inSouthwest, fireActivity, largeFireRating, startsAverage, imtSummary, crewSummary, outlookSummary, dangerSummary,
      outlookRating, crewRatio, plLevel, weightsFor };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeCalc;
  else root.PL_CALC = makeCalc(root.PL_CONFIG);
})(typeof window !== "undefined" ? window : globalThis);
