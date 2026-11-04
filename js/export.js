/*
 * SWA Preparedness Level — exports: Excel workbook and plain-text briefing.
 * Shared by the page (Briefing & Export tab) and scripts/make-report.mjs.
 */
(function (root) {
  "use strict";

  function makeExport(C, calc, makeXlsx) {
    const pad = (n) => String(n).padStart(2, "0");
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : ""; };
    const r1 = (v) => (v === "" ? "" : Math.round(v * 10) / 10);
    function parseDate(s) {
      const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null;
    }
    function fmt(s, withTime) {
      const d = parseDate(s);
      if (!d) return s || "";
      const base = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
      return withTime && /[T ]\d{2}:\d{2}/.test(s) ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
    }
    function days(state) {
      const d0 = parseDate(state.outlook.startDate) || new Date();
      return Array.from({ length: 7 }, (_, i) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i));
    }
    const presetLabel = (state) => (state.preset === "custom" ? "Custom weights" : (C.weightPresets[state.preset] || {}).label || "");
    const binOf = (v) => { const n = parseFloat(v); if (!Number.isFinite(n)) return null; return n < 50 ? 0 : n < 90 ? 1 : n < 97 ? 2 : 3; };
    const fileStamp = (state) => {
      const d = parseDate(state.meta.asOf) || new Date();
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    };

    function briefingText(state, r) {
      r = r || calc.compute(state);
      const lines = [`SWA Preparedness Level: PL${r.pl} (score ${r.score.toFixed(3)})`,
        `As of ${fmt(state.meta.asOf, true)}${state.meta.preparedBy ? ` – ${state.meta.preparedBy}` : ""}`,
        `Model: ${presetLabel(state)}`, ""];
      for (const e of r.elements) lines.push(`${e.name}: ${e.rating} (${e.contribution.toFixed(3)} of ${e.weight.toFixed(2)})`);
      lines.push("", `7-Day outlook (Day 1 ${fmt(state.outlook.startDate)}): daily scores ${r.outlook.daily.map((d) => d.score).join(", ")}; 7-day average ${r.outlook.avg.toFixed(2)}`);
      lines.push(`ERCy (${fmt(state.danger.date)}): ${r.danger.bins.p97plus} PSAs at 97th+, ${r.danger.bins.p90to96} at 90th–96th, ${r.danger.bins.p50to89} at 50th–89th, ${r.danger.bins.below50} under 50th`);
      if (state.meta.notes) lines.push("", state.meta.notes);
      return lines.join("\n");
    }

    function workbook(state, r) {
      r = r || calc.compute(state);
      const H = (v) => ({ v, s: "head" });
      const B = (v) => ({ v, s: "bold" });
      const R = (rating) => ({ v: rating, s: rating });
      const sheets = [];

      /* PL outcome */
      const rows = [
        [{ v: "Southwest Area Preparedness Level", s: "title" }],
        [{ v: `As of ${fmt(state.meta.asOf, true)}${state.meta.preparedBy ? ` · ${state.meta.preparedBy}` : ""} · ${presetLabel(state)}`, s: "sub" }],
        [],
        [B("Preparedness Level"), { v: `PL${r.pl}`, s: ["", "Minimum", "Low", "Moderate", "High", "Maximum"][r.pl] }, B("PL score"), r.score],
        [],
        [H("Element"), H("Adjective rating"), H("Max contribution (of 1.0)"), H("Actual contribution"), H("Data date")],
      ];
      const dates = { fire: fmt(state.fire.updated, true), imt: fmt(state.imtsUpdated, true), crews: fmt(state.crewsUpdated, true),
        outlook: fmt(state.outlook.startDate), danger: fmt(state.danger.date) };
      for (const [g, label] of [["occurring", "What is occurring (within the Southwest Area)…"], ["could", "What could occur…"]]) {
        rows.push([{ v: label, s: "bold" }]);
        for (const e of r.elements.filter((x) => x.group === g)) rows.push([e.name, R(e.rating), e.weight, e.contribution, dates[e.key]]);
      }
      rows.push([B("PL score"), B(`PL${r.pl}`), r.weightTotal, B(r.score)]);
      rows.push([], [B("PL ranges")], ...C.plLevels.map((l, i) => [`PL${l.pl}`, `${l.min} – ${C.plLevels[i + 1] ? `below ${C.plLevels[i + 1].min}` : "1.0"}`]));
      if (state.meta.notes) rows.push([], [B("Notes")], [state.meta.notes]);
      sheets.push({ name: "PL_Outcome", cols: [36, 18, 24, 20, 20], rows });

      /* 7-Day */
      const ds = days(state);
      const dh = ds.map((d) => `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getMonth() + 1}/${d.getDate()}`);
      const o = [
        [{ v: "7-Day Significant Fire Potential", s: "title" }],
        [{ v: `Day 1: ${fmt(state.outlook.startDate)} · ${state.outlook.source || "Manual entry"}`, s: "sub" }],
        [],
        [H("PSA"), H("Description"), ...dh.map(H)],
        ...C.psas.map((p) => [B(p.id), p.name, ...ds.map((_, d) => { const v = num((state.outlook.values[p.id] || [])[d]); return { v, s: v ? `lv${v}` : "normal" }; })]),
        [],
        [H("PSA count"), H(""), ...dh.map(H), H("7-Day avg")],
        ...C.outlook.levels.map((l) => [{ v: l.label, s: `lv${l.value}` }, "", ...r.outlook.daily.map((d) => ({ v: d.counts[l.value], s: `lv${l.value}` })),
          Math.round((r.outlook.daily.reduce((a, d) => a + d.counts[l.value], 0) / 7) * 100) / 100]),
        [B("Risk score"), "", ...r.outlook.daily.map((d) => B(d.score)), B(r.outlook.avg)],
        [B("PL rating"), "", ...r.outlook.daily.map((d) => R(d.rating)), R(r.outlook.rating)],
      ];
      sheets.push({ name: "7-Day", cols: [22, 26, 11, 11, 11, 11, 11, 11, 11, 11], rows: o });

      /* ERCy */
      const n = r.danger.count;
      const e = [
        [{ v: "PSA ERCy Values (Observed Fire Danger)", s: "title" }],
        [{ v: `Updated: ${fmt(state.danger.date)} · ${state.danger.source || "Manual entry"}`, s: "sub" }],
        [],
        [H("PSA"), H("Description"), H("ERCyPerc"), H("ERCyVal"), H("BIyPerc"), H("BIyVal"), H("Stations")],
        ...C.psas.map((p) => {
          const x = state.danger.rows[p.ercId] || {};
          const ep = num(x.ercPct), bp = num(x.biPct);
          return [B(p.ercId), p.name, { v: ep, s: binOf(ep) === null ? "normal" : `b${binOf(ep)}` }, r1(num(x.ercVal)),
            { v: bp, s: binOf(bp) === null ? "normal" : `b${binOf(bp)}` }, r1(num(x.biVal)), x.stationsListed ? `${x.stations}/${x.stationsListed}` : ""];
        }),
        [],
        ["", "", H("PSA count ERCyPerc"), H("% of PSAs ERCy"), H("PSA count BI-y"), H("% of PSAs BI-y")],
        ...[["<50th percentile", "below50", 0], ["50th-89th percentile", "p50to89", 1], ["90th-96th percentile", "p90to96", 2], ["97th+ percentile", "p97plus", 3]]
          .map(([label, k, b]) => ["", label, { v: r.danger.bins[k], s: `b${b}` }, `${Math.round((r.danger.bins[k] / n) * 100)}%`, { v: r.danger.biBins[k], s: `b${b}` }, `${Math.round((r.danger.biBins[k] / n) * 100)}%`]),
        [],
        [B("Fire Danger Metric"), R(r.danger.rating)],
      ];
      if (state.danger.percentiles) e.push([{ v: state.danger.percentiles, s: "sub" }]);
      sheets.push({ name: "PSA_ERCy", cols: [20, 28, 18, 16, 16, 16, 10], rows: e });

      /* IMTs */
      sheets.push({ name: "IMTs", cols: [8, 10, 10, 18, 12, 10, 22, 12, 30], rows: [
        [{ v: "IMT Availability", s: "title" }],
        [{ v: `Updated ${fmt(state.imtsUpdated, true)} · Availability metric: ${r.imt.rating} · CIMTs available ${r.imt.availCimt}/${r.imt.cimt} · Type 3 available ${r.imt.availT3}/${r.imt.t3}`, s: "sub" }],
        [],
        ["Mob", "Type", "No./Zone", "Incident Commander", "Home", "Status", "Incident", "Date comm.", "Remarks"].map(H),
        ...state.imts.map((t) => [t.mob, t.type, t.zone, t.ic, t.home, B(t.status), t.incident, t.dateComm, t.remarks]),
      ] });

      /* Crews */
      const crewRow = (c) => [c.name, c.type, c.state, c.disp, c.unit, c.dayOff, B(c.status), c.location, c.incident, c.dateCom, c.remarks];
      const crewHead = ["Crew", "Type", "Home state", "Home disp.", "Home unit", "Day off", "Status", "Location", "Incident", "Date com.", "Remarks"].map(H);
      sheets.push({ name: "Crews", cols: [16, 8, 8, 10, 10, 9, 8, 10, 22, 12, 24], rows: [
        [{ v: "T-1/T2IA Crew Availability", s: "title" }],
        [{ v: `Updated ${fmt(state.crewsUpdated, true)} · Total availability metric: ${r.crews.rating} · ${r.crews.totalAvail} of ${r.crews.swaTotal} available (${Math.round(r.crews.ratio * 100)}%)`, s: "sub" }],
        [], [B("SWA crews")], crewHead, ...state.crews.map(crewRow),
        [], [B("Out-of-area crews in SWA")], crewHead, ...(state.ooaCrews || []).map(crewRow),
      ] });

      /* Fire activity */
      sheets.push({ name: "Fire_Activity", cols: [28, 16], rows: [
        [{ v: "Fire Activity", s: "title" }],
        [{ v: `Updated ${fmt(state.fire.updated, true)}`, s: "sub" }], [],
        [B("Complex incidents (T2+)"), num(state.fire.complex)], [B("T3 incidents"), num(state.fire.t3)],
        [B("SWA total incidents"), r.fire.total], [B("Fire Activity rating"), R(r.fire.rating)], [B("Suggested from counts"), r.fire.suggested],
      ] });

      if ((state.danger.stations || []).length) {
        sheets.push({ name: "FEMS_Stations", cols: [10, 28, 10, 20, 10, 10], rows: [
          [{ v: `FEMS station values, ${fmt(state.danger.date)}`, s: "title" }], [],
          ["PSA", "Station", "ID", "Observation (local)", "ERCy", "BIy"].map(H),
          ...state.danger.stations.map((s) => [s.psa, s.name, s.id, s.time || "no report", num(s.erc), num(s.bi)]),
        ] });
      }
      return makeXlsx(sheets);
    }

    return { briefingText, workbook, fileStamp, presetLabel };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = makeExport;
  else root.PL_EXPORT = makeExport(root.PL_CONFIG, root.PL_CALC, root.PL_XLSX);
})(typeof window !== "undefined" ? window : globalThis);
