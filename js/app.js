/*
 * SWA Preparedness Level — user interface.
 * Data flow: state (plain object) → PL_CALC.compute(state) → render.
 * State is saved in this browser (localStorage). "Published data" is data/current.json,
 * which a future automated job can overwrite without touching this code.
 */
(function () {
  "use strict";
  const C = window.PL_CONFIG;
  const calc = window.PL_CALC;
  const Sources = window.PL_SOURCES;
  const Exporter = window.PL_EXPORT;
  const ErcImport = window.PL_ERC_IMPORT;
  const NO_PULL = /[?&]nopull\b/.test(location.search);
  const STORE_KEY = "swa-pl-state-v1";
  const $ = (s, el = document) => el.querySelector(s);

  const VIEWS = [
    { id: "outcome", label: "PL Outcome" },
    { id: "fire", label: "Fire Activity", el: "fire" },
    { id: "imt", label: "IMTs", el: "imt" },
    { id: "crews", label: "Crews", el: "crews" },
    { id: "outlook", label: "7-Day Outlook", el: "outlook" },
    { id: "danger", label: "PSA ERCy", el: "danger" },
    { id: "briefing", label: "Briefing & Export" },
    { id: "history", label: "History & Data" },
    { id: "model", label: "Model & Data" },
  ];

  let state = null;
  let published = null;
  let source = "";
  let result = null;
  let view = "outcome";

  /* ---------- helpers ---------- */
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pad = (n) => String(n).padStart(2, "0");
  const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fmt3 = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
  const fmt2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const pct = (n) => `${Math.round(n * 100)}%`;
  const normId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  function parseDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    const u = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (u) return new Date(+u[3] < 100 ? 2000 + +u[3] : +u[3], +u[1] - 1, +u[2]);
    return null;
  }
  function fmtDate(s, withTime) {
    const d = parseDate(s);
    if (!d) return s ? esc(s) : "—";
    const opts = { month: "short", day: "numeric", year: "numeric" };
    if (withTime && /[T ]\d{2}:\d{2}/.test(s)) Object.assign(opts, { hour: "2-digit", minute: "2-digit", hour12: false });
    return d.toLocaleString("en-US", opts);
  }
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /* Color shows pressure on the PL. For availability (inverted) elements, a Minimum rating pushes the PL up,
     so it takes the color a Maximum rating would have. */
  const INV = { Minimum: "Maximum", Low: "High", Moderate: "Moderate", High: "Low", Maximum: "Minimum" };
  const sev = (r, inverted) => (inverted ? INV[r] || r : r);
  const chip = (r, lg, inverted) => `<span class="chip${lg ? " lg" : ""}" data-r="${esc(sev(r, inverted))}">${esc(r)}</span>`;
  const statusGroup = (list, code) => (list.find((s) => s.code === code) || {}).group || "other";

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
  }

  /* ---------- state ---------- */
  function defaults() {
    const values = {};
    for (const p of C.psas) values[p.id] = [1, 1, 1, 1, 1, 1, 1];
    const rows = {};
    for (const p of C.psas) rows[p.ercId] = { ercVal: "", ercPct: "", biVal: "", biPct: "" };
    return {
      schema: 1,
      meta: { asOf: nowLocal(), preparedBy: "", notes: "", source: "blank" },
      preset: C.defaultPreset, weights: { ...C.weightPresets[C.defaultPreset].weights },
      fire: { rating: "Minimum", complex: 0, t3: 0, updated: "" },
      imts: clone(C.imts).map((t) => ({ incident: "", dateComm: "", remarks: "", ...t })), imtsUpdated: "",
      crews: clone(C.crews), ooaCrews: [], crewsUpdated: "",
      outlook: { startDate: isoDay(new Date()), values, updated: "" },
      danger: { date: "", rows },
    };
  }
  function normalize(s) {
    const d = defaults();
    const out = { ...d, ...s };
    out.meta = { ...d.meta, ...(s.meta || {}) };
    out.fire = { ...d.fire, ...(s.fire || {}) };
    out.outlook = { ...d.outlook, ...(s.outlook || {}), values: { ...d.outlook.values, ...((s.outlook || {}).values || {}) } };
    out.danger = { ...d.danger, ...(s.danger || {}), rows: { ...d.danger.rows, ...((s.danger || {}).rows || {}) } };
    out.weights = { ...d.weights, ...(s.weights || {}) };
    return out;
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); source = "local"; } catch (e) { /* storage unavailable */ }
    renderFooter();
  }
  async function loadPublished() {
    if (window.PL_SEED) return clone(window.PL_SEED);
    try {
      const r = await fetch("data/current.json", { cache: "no-store" });
      if (r.ok) return await r.json();
    } catch (e) { /* offline or file:// */ }
    return null;
  }
  /* Bring in auto-pulled sections from the published file when they are newer than what this browser has. */
  function mergeNewer(pub) {
    const took = [];
    if (!pub) return took;
    if (pub.outlook && (pub.outlook.startDate || "") > (state.outlook.startDate || "")) { state.outlook = clone(pub.outlook); took.push("7-Day outlook"); }
    const dKey = (d) => `${(d && d.date) || ""}|${(d && d.fetchedAt) || ""}`;
    if (pub.danger && dKey(pub.danger) > dKey(state.danger)) { state.danger = clone(pub.danger); took.push("ERC/BI"); }
    const newer = (k) => ((pub[k] || {}).fetchedAt || "") > ((state[k] || {}).fetchedAt || "");
    if (newer("crewsSource")) { Object.assign(state, clone({ crews: pub.crews, ooaCrews: pub.ooaCrews || [], crewsUpdated: pub.crewsUpdated, crewsSource: pub.crewsSource })); took.push("crews"); }
    if (newer("imtsSource")) { Object.assign(state, clone({ imts: pub.imts, imtsUpdated: pub.imtsUpdated, imtsSource: pub.imtsSource })); took.push("IMTs"); }
    return took;
  }
  async function init() {
    published = await loadPublished();
    let local = null;
    try { local = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { local = null; }
    if (local) {
      state = normalize(local); source = "local";
      const took = mergeNewer(published);
      if (took.length) { save(); setTimeout(() => toast(`Newer ${took.join(", ")} loaded`), 300); }
    } else if (published) { state = normalize(clone(published)); source = "published"; }
    else { state = defaults(); source = "blank"; }
    renderTabs();
    route();
    window.addEventListener("hashchange", route);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onInput);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    document.addEventListener("dragover", (e) => { const z = e.target.closest && e.target.closest("#erc-drop"); if (z) { e.preventDefault(); z.classList.add("over"); } });
    document.addEventListener("dragleave", (e) => { const z = e.target.closest && e.target.closest("#erc-drop"); if (z) z.classList.remove("over"); });
    document.addEventListener("drop", (e) => { const z = e.target.closest && e.target.closest("#erc-drop"); if (z) { e.preventDefault(); z.classList.remove("over"); importErcFile(e.dataTransfer.files[0]); } });
    autoPull();
  }

  /* ---------- live pulls ---------- */
  const todayIso = () => isoDay(new Date());
  function autoPull() {
    if (!C.autoData.pullOnLoad || !Sources || NO_PULL) return;
    if ((state.outlook.startDate || "") < todayIso()) pullOutlook(true);
  }
  async function pullOutlook(quiet) {
    setPullStatus("outlook", "Pulling the 7-Day product from NPSG…", "muted");
    try {
      const o = await Sources.fetchOutlook();
      state.outlook = o; save();
      pullStatus.outlook = "";
      if (view === "outlook") renderView(); else refresh();
      toast(`7-Day outlook updated (Day 1 ${fmtDate(o.startDate)})`);
    } catch (e) {
      const took = mergeNewer(await loadPublished());
      if (took.includes("7-Day outlook")) { save(); renderView(); }
      setPullStatus("outlook", `Live pull failed: ${esc(e.message)} The source may not allow direct requests from this page; the scheduled job pulls it for everyone.${took.includes("7-Day outlook") ? " Loaded the copy saved by the scheduled job instead." : ""}`, quiet ? "muted" : "warn");
    }
  }
  function setPath(path, value) {
    const parts = path.split(".");
    let o = state;
    while (parts.length > 1) { const k = parts.shift(); o = o[k] = o[k] ?? {}; }
    o[parts[0]] = value;
  }

  /* ---------- routing / top-level render ---------- */
  function route() {
    const h = location.hash.replace("#", "");
    view = VIEWS.some((v) => v.id === h) ? h : "outcome";
    renderView();
    window.scrollTo({ top: 0 });
  }
  function renderTabs() {
    $("#tabs").innerHTML = VIEWS.map((v) =>
      `<a class="tab" href="#${v.id}" data-view="${v.id}">${v.el ? `<i class="dot" data-el="${v.el}"></i>` : ""}${esc(v.label)}</a>`).join("");
  }
  function refresh() {
    result = calc.compute(state);
    const plate = $("#hdr-plate");
    plate.dataset.pl = result.pl;
    $("#hdr-pl").textContent = result.pl;
    $("#hdr-score").textContent = fmt3(result.score);
    $("#hdr-asof").textContent = `As of ${fmtDate(state.meta.asOf, true).replace(/<[^>]+>/g, "")} · ${presetLabel()}`;
    document.title = `PL${result.pl} · SWA Preparedness Level`;
    for (const a of document.querySelectorAll(".tab")) {
      a.setAttribute("aria-current", a.dataset.view === view ? "page" : "false");
      const dot = a.querySelector(".dot");
      if (dot) {
        const el = result.elements.find((e) => e.key === dot.dataset.el);
        dot.dataset.r = sev(el.rating, el.inverted);
        dot.title = `${el.name}: ${el.rating}`;
      }
    }
    const s = $("#summary");
    if (s && SUMMARY[view]) s.innerHTML = SUMMARY[view]();
    for (const fn of AFTER[view] || []) fn();
  }
  function renderView() {
    result = calc.compute(state);
    $("#main").innerHTML = VIEW[view]();
    refresh();
    renderFooter();
  }
  function renderFooter() {
    const msg = {
      local: "Showing your edits, saved in this browser. Other people see their own copy until data is published to data/current.json.",
      published: "Showing published data from data/current.json. Edits you make are saved in this browser.",
      blank: "No published data found. Starting from a blank form; edits are saved in this browser.",
    }[source];
    const f = $("#foot-source"); if (f) f.textContent = msg;
  }
  const presetLabel = () => state.preset === "custom" ? "Custom weights" : (C.weightPresets[state.preset] || {}).label || "";

  const head = (title, lede, extra = "") => `
    <div class="view-head"><div><h2>${title}</h2>${lede ? `<p class="lede">${lede}</p>` : ""}</div>${extra}</div>`;
  const updatedField = (path, value, label = "Updated") => `
    <label class="field"><span>${label}</span><input type="datetime-local" id="f-${path.replace(/\W/g, "-")}" data-path="${path}" value="${esc(value)}"></label>`;

  /* ================= VIEWS ================= */
  const VIEW = {};
  const SUMMARY = {};
  const AFTER = {};

  /* ---------- Outcome ---------- */
  VIEW.outcome = () => `
    ${head("Preparedness Level outcome", "Each element gets an adjective rating. The rating's multiplier times the element's weight is its contribution; contributions add up to the PL score.")}
    <section class="panel" id="summary"></section>
    <div class="grid-2">
      <section class="panel">
        <h3>Briefing details</h3>
        <div class="row">
          <label class="field"><span>PL as of</span><input type="datetime-local" id="f-asof" data-path="meta.asOf" value="${esc(state.meta.asOf)}"></label>
          <label class="field" style="flex:1"><span>Prepared by</span><input type="text" id="f-prepared" data-path="meta.preparedBy" value="${esc(state.meta.preparedBy)}" placeholder="Name / initials"></label>
        </div>
        <label class="field"><span>Notes</span><textarea id="f-notes" data-path="meta.notes" placeholder="Context for this PL call">${esc(state.meta.notes)}</textarea></label>
      </section>
      <section class="panel">
        <h3>Share</h3>
        <p class="muted small">Copy a plain-text summary for email, a briefing, or Teams.</p>
        <textarea id="f-brief" readonly></textarea>
        <div class="btn-row"><button class="btn primary" data-act="copy-brief">Copy summary</button></div>
      </section>
    </div>`;
  SUMMARY.outcome = () => {
    const r = result;
    const bounds = C.plLevels.map((l, i) => [l.min, (C.plLevels[i + 1] || { min: 1 }).min]);
    const seg = bounds.map(([a, b], i) => `<div class="scale-seg${r.pl === i + 1 ? " on" : ""}" data-pl="${i + 1}" style="width:${(b - a) * 100}%">PL${i + 1}</div>`).join("");
    const pos = Math.max(0, Math.min(1, r.score)) * 100;
    const ticks = [0, ...C.plLevels.slice(1).map((l) => l.min), 1].map((t) => `<span style="left:${t * 100}%">${t}</span>`).join("");
    const updated = { fire: [state.fire.updated, true], imt: [state.imtsUpdated, true], crews: [state.crewsUpdated, true],
      outlook: [state.outlook.startDate, false], danger: [state.danger.date, false] };
    const groups = [["occurring", "What is occurring (within the Southwest Area)"], ["could", "What could occur"]];
    const viewFor = { fire: "fire", imt: "imt", crews: "crews", outlook: "outlook", danger: "danger" };
    const rows = groups.map(([g, label]) => `<tr class="group-row"><td colspan="5">${label}</td></tr>` +
      r.elements.filter((e) => e.group === g).map((e) => `
        <tr data-r="${sev(e.rating, e.inverted)}">
          <td class="el-name"><a href="#${viewFor[e.key]}">${esc(e.name)}</a>${e.inverted ? `<div class="muted small">Inverted scale: less available, higher PL</div>` : ""}</td>
          <td>${chip(e.rating, false, e.inverted)}</td>
          <td class="num">${fmt2(e.weight)}</td>
          <td><div class="contrib"><div class="track" title="${fmt3(e.contribution)} of ${fmt2(e.weight)}">
            <div class="cap" style="width:${e.weight * 100}%"></div><div class="fill" style="width:${e.contribution * 100}%"></div></div>
            <b>${fmt3(e.contribution)}</b></div></td>
          <td class="small muted">${fmtDate(...updated[e.key])}</td>
        </tr>`).join("")).join("");
    const wWarn = Math.abs(r.weightTotal - 1) > 0.001 ? `<p class="warn">Weights add up to ${fmt2(r.weightTotal)}, not 1.00. Adjust them under Model &amp; Data.</p>` : "";
    return `
      <div class="panel-head"><h3>PL${r.pl} &nbsp;·&nbsp; score ${fmt3(r.score)}</h3><span class="tag">${esc(presetLabel())}</span></div>
      <div class="scale"><div class="scale-bar">${seg}<div class="scale-marker" style="left:${pos}%"><span style="${pos < 4 ? "left:0;transform:none" : pos > 96 ? "left:auto;right:0;transform:none" : ""}">${fmt3(r.score)}</span></div></div>
        <div class="scale-ticks">${ticks}</div></div>
      ${wWarn}
      <div class="table-wrap"><table>
        <thead><tr><th>Element</th><th>Adjective rating</th><th class="num">Max contribution</th><th>Actual contribution</th><th>Data date</th></tr></thead>
        <tbody>${rows}
          <tr class="total-row"><td>PL score</td><td>PL${r.pl}</td><td class="num">${fmt2(r.weightTotal)}</td><td><b>${fmt3(r.score)}</b></td><td></td></tr>
        </tbody></table></div>`;
  };
  AFTER.outcome = [() => { const b = $("#f-brief"); if (b) b.value = briefText(); }];
  function briefText() { return Exporter ? Exporter.briefingText(state, result) : ""; }

  /* ---------- Briefing & Export ---------- */
  VIEW.briefing = () => `
    <div class="no-print">
    ${head("Briefing &amp; Export", "A one-page PL briefing built from the current data. Save it as a PDF or download the Excel workbook to attach to an email.")}
    <section class="panel export-panel">
      <div class="export-grid">
        <div class="export-item">
          <h3>PDF</h3>
          <p class="muted small">Opens your browser's print window. Choose <b>Save as PDF</b> as the printer.</p>
          <button class="btn primary" data-act="print">Save briefing as PDF</button>
        </div>
        <div class="export-item">
          <h3>Excel</h3>
          <p class="muted small">Workbook with PL outcome, 7-Day, PSA ERC, IMT, crew and fire activity sheets.</p>
          <button class="btn primary" data-act="xlsx">Download Excel workbook</button>
        </div>
        <div class="export-item">
          <h3>Email</h3>
          <p class="muted small">Opens a draft in your mail app with the summary in the body. Attach the PDF or Excel file you saved.</p>
          <div class="btn-row"><button class="btn" data-act="email">Open email draft</button><button class="btn" data-act="copy-brief">Copy summary</button></div>
        </div>
        <div class="export-item" id="latest-files" hidden>
          <h3>Latest scheduled report</h3>
          <p class="muted small" id="latest-when">Made automatically with each scheduled update.</p>
          <div class="btn-row"><a class="btn" href="reports/SWA_PL_latest.pdf" download>PDF</a><a class="btn" href="reports/SWA_PL_latest.xlsx" download>Excel</a></div>
        </div>
      </div>
      <textarea id="f-brief" class="visually-hidden" readonly tabindex="-1" aria-hidden="true"></textarea>
    </section>
    </div>
    <div id="summary"></div>`;
  SUMMARY.briefing = () => {
    const r = result;
    const n = r.danger.count;
    const ercRows = C.psas.map((p) => {
      const x = state.danger.rows[p.ercId] || {};
      const cell = (v) => { const b = binOf(v); return `<td class="num${b === "" ? "" : " bin"}" data-bin="${b}">${esc(showVal(v))}</td>`; };
      return `<tr><td class="psa-id">${p.ercId}</td><td class="psa-name">${esc(p.name)}</td>${cell(x.ercPct)}<td class="num">${esc(showVal(x.ercVal))}</td>${cell(x.biPct)}<td class="num">${esc(showVal(x.biVal))}</td></tr>`;
    }).join("");
    const f = r.fire, m = r.imt, c = r.crews;
    return `<article class="report">
      <header class="rep-head">
        <div><p class="eyebrow">Southwest Area · Predictive Services</p>
          <h2>Southwest Area Preparedness Level</h2>
          <p class="muted">As of ${fmtDate(state.meta.asOf, true)}${state.meta.preparedBy ? ` · ${esc(state.meta.preparedBy)}` : ""} · ${esc(presetLabel())}</p></div>
        <div class="pl-plate rep-plate" data-pl="${r.pl}"><span class="pl-big"><span class="pl-label">PL</span><span class="pl-num">${r.pl}</span></span><span class="pl-score">Score <b>${fmt3(r.score)}</b></span></div>
      </header>
      <section class="rep-sec">${SUMMARY.outcome()}</section>
      <section class="rep-sec rep-facts">
        <div><h3>Fire Activity ${chip(f.rating)}</h3><p class="small">${f.complex} complex (T2+) and ${f.t3} T3 incidents; ${f.total} total.</p></div>
        <div><h3>IMTs ${chip(m.rating, false, true)}</h3><p class="small">CIMTs available ${m.availCimt} of ${m.cimt}; Type 3 available ${m.availT3} of ${m.t3}; CIMTs committed ${m.commCimt}.</p></div>
        <div><h3>Crews ${chip(c.rating, false, true)}</h3><p class="small">${c.totalAvail} of ${c.swaTotal} available (${pct(c.ratio)}); ${c.swa.committed} committed in SWA; ${c.ooaTotal} OOA crews.</p></div>
        ${(() => { const fs1 = state.fireStarts, y = fs1 && fs1.daily && fs1.daily[fs1.to]; return y ? `<div><h3>New starts ${fmtDate(fs1.to)}</h3><p class="small"><b>${y.total}</b> total: ${y.lightning} lightning, ${y.human} human, ${y.unknown} unknown; ${y.acres} acres (WFIGS).</p></div>` : ""; })()}
      </section>
      <section class="rep-sec">
        <div class="panel-head"><h3>7-Day Significant Fire Potential</h3><span class="muted small">Day 1 ${fmtDate(state.outlook.startDate)} · ${esc(state.outlook.source || "Manual entry")}</span></div>
        ${SUMMARY.outlook()}
      </section>
      <section class="rep-sec">
        <div class="panel-head"><h3>PSA ERCy Values (observed fire danger)</h3><span class="muted small">Updated ${fmtDate(state.danger.date)} · ${esc(state.danger.source || "Manual entry")}</span></div>
        <div class="rep-erc">
          <div class="table-wrap"><table class="erc-table">
            <thead><tr><th>PSA</th><th>Description</th><th class="num">ERCy perc</th><th class="num">ERCy val</th><th class="num">BIy perc</th><th class="num">BIy val</th></tr></thead>
            <tbody>${ercRows}</tbody></table></div>
          <div>${SUMMARY.danger()}</div>
        </div>
      </section>
      ${state.meta.notes ? `<section class="rep-sec"><h3>Notes</h3><p class="rep-notes">${esc(state.meta.notes)}</p></section>` : ""}
      <p class="muted small rep-foot">PL1 &lt; 0.151 ≤ PL2 &lt; 0.386 ≤ PL3 &lt; 0.62 ≤ PL4 &lt; 0.851 ≤ PL5 · Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
    </article>`;
  };
  AFTER.briefing = [() => { const b = $("#f-brief"); if (b) b.value = briefText(); }, checkLatestFiles];
  async function checkLatestFiles() {
    const box = $("#latest-files");
    if (!box || box.dataset.checked) return;
    box.dataset.checked = "1";
    try {
      const r = await fetch("reports/SWA_PL_latest.pdf", { method: "HEAD", cache: "no-store" });
      if (r.ok) {
        box.hidden = false;
        const lm = r.headers.get("last-modified");
        if (lm) $("#latest-when").textContent = `Made automatically ${new Date(lm).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Reflects the published data, not edits in this browser.`;
      }
    } catch (e) { /* not on a server, or no report yet */ }
  }
  function downloadBytes(bytes, name, type) {
    const blob = new Blob([bytes], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function exportXlsx() {
    downloadBytes(Exporter.workbook(state, result), `SWA_PL_${Exporter.fileStamp(state)}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    toast("Excel workbook downloaded");
  }
  function printBriefing() {
    if (view !== "briefing") { location.hash = "#briefing"; setTimeout(() => window.print(), 400); }
    else window.print();
  }
  function emailDraft() {
    const subject = `SWA Preparedness Level PL${result.pl} – ${fmtDate(state.meta.asOf, true)}`;
    const body = `${briefText()}\n\n(Briefing PDF / Excel attached.)`;
    location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  /* ---------- Fire Activity ---------- */
  VIEW.fire = () => `
    ${head("Fire Activity", "Choose the rating that best describes current fire activity in the Southwest Area. Incident counts give a suggested rating; the selection is yours.", `<div class="row">${updatedField("fire.updated", state.fire.updated)}</div>`)}
    <section class="panel">
      <h3>Current incidents</h3>
      <div class="row">
        <label class="field"><span>Complex incidents (T2 or higher)</span><input type="number" min="0" id="f-complex" data-path="fire.complex" data-num value="${esc(state.fire.complex)}"></label>
        <label class="field"><span>T3 incidents</span><input type="number" min="0" id="f-t3" data-path="fire.t3" data-num value="${esc(state.fire.t3)}"></label>
      </div>
      <div id="summary"></div>
    </section>
    <section class="panel">
      <h3>Fire Activity rating</h3>
      <div class="rating-cards">${C.fireActivity.map((f) => `
        <label class="rating-card" data-r="${f.rating}">
          <input type="radio" name="fire-rating" id="f-fire-${f.rating}" data-path="fire.rating" value="${f.rating}" ${state.fire.rating === f.rating ? "checked" : ""}>
          <span class="t">${f.rating}<span class="tag" data-suggest="${f.rating}" hidden>Suggested</span></span>
          <p>${esc(f.text)}</p>
        </label>`).join("")}</div>
    </section>`;
  SUMMARY.fire = () => {
    const f = result.fire;
    const fs1 = state.fireStarts, y = fs1 && fs1.daily && fs1.daily[fs1.to];
    const yesterday = y ? `<p class="small">New starts ${fmtDate(fs1.to)} (WFIGS): <b>${y.total}</b> · lightning ${y.lightning} · human ${y.human} · unknown ${y.unknown} · ${y.acres} acres. <a href="#history">History</a></p>` : "";
    const match = f.suggested === f.rating;
    return `<div class="metric" data-r="${f.suggested}">
      <span class="label">SWA total incidents: ${f.total}</span>
      <span>Suggested rating ${chip(f.suggested)}</span>
      ${match ? `<span class="muted small">Matches your selection.</span>` : `<button class="btn" data-act="use-suggested">Use ${esc(f.suggested)}</button>`}
    </div>${yesterday}`;
  };
  AFTER.fire = [() => {
    for (const t of document.querySelectorAll("[data-suggest]")) t.hidden = t.dataset.suggest !== result.fire.suggested;
  }];

  /* ---------- IMTs ---------- */
  VIEW.imt = () => `
    ${head("IMT Availability", "Team status comes from the SWCC SharePoint workbook and can be changed here. Availability uses an inverted scale: fewer available teams raises the PL.", `<div class="row">${updatedField("imtsUpdated", state.imtsUpdated)}</div>`)}
    ${sourceBar("imts")}
    <section class="panel" id="summary"></section>
    <section class="panel">
      <div class="panel-head"><h3>Team status</h3><button class="btn" data-act="add-imt">Add team</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Mob</th><th>Type</th><th>No. / Zone</th><th>Incident Commander</th><th>Home dispatch</th><th>Status</th><th>Incident</th><th>Date comm.</th><th>Remarks</th><th></th></tr></thead>
        <tbody>${state.imts.map((t, i) => `<tr>
          <td><input type="text" class="w-s" id="imt-${i}-mob" data-list="imts" data-idx="${i}" data-field="mob" value="${esc(t.mob)}"></td>
          <td><select id="imt-${i}-type" data-list="imts" data-idx="${i}" data-field="type">${C.imtTypes.map((o) => `<option ${String(t.type) === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
          <td><input type="text" class="w-s" id="imt-${i}-zone" data-list="imts" data-idx="${i}" data-field="zone" value="${esc(t.zone)}"></td>
          <td><input type="text" class="w-m" id="imt-${i}-ic" data-list="imts" data-idx="${i}" data-field="ic" value="${esc(t.ic)}"></td>
          <td><input type="text" class="w-s" id="imt-${i}-home" data-list="imts" data-idx="${i}" data-field="home" value="${esc(t.home)}"></td>
          <td>${statusSelect(`imt-${i}-status`, "imts", i, t.status, C.imtStatuses)}</td>
          <td><input type="text" class="w-m" id="imt-${i}-inc" data-list="imts" data-idx="${i}" data-field="incident" value="${esc(t.incident)}"></td>
          <td><input type="date" id="imt-${i}-date" data-list="imts" data-idx="${i}" data-field="dateComm" value="${esc(t.dateComm)}"></td>
          <td><input type="text" class="w-l" id="imt-${i}-rem" data-list="imts" data-idx="${i}" data-field="remarks" value="${esc(t.remarks)}"></td>
          <td><button class="btn icon" data-act="del-row" data-list="imts" data-idx="${i}" aria-label="Remove ${esc(t.ic)}">✕</button></td>
        </tr>`).join("")}</tbody></table></div>
      <p class="muted small">Available = ${C.imtStatuses.filter((s) => s.group === "available").map((s) => s.code).join(", ")}. Committed = C.</p>
    </section>`;
  SUMMARY.imt = () => {
    const m = result.imt;
    return `<div class="panel-head"><h3>Team Availability metric</h3>${chip(m.rating, true, true)}</div>
      <div class="stats">
        <div class="stat"><span class="k">CIMTs available</span><span class="v">${m.availCimt} <small>of ${m.cimt}</small></span></div>
        <div class="stat"><span class="k">Type 3 available</span><span class="v">${m.availT3} <small>of ${m.t3}</small></span></div>
        <div class="stat"><span class="k">All teams available</span><span class="v">${m.availAll} <small>of ${m.total}</small></span></div>
        <div class="stat"><span class="k">CIMTs committed</span><span class="v">${m.commCimt}</span></div>
        <div class="stat"><span class="k">Type 3 committed</span><span class="v">${m.commT3}</span></div>
      </div>
      <div class="metric" data-r="${sev(m.rating, true)}"><span class="label">Availability ${chip(m.rating, false, true)}</span>
        <span class="why">0 CIMTs available → Minimum · 1–2 → Low · 3 → Moderate · 4+ → High, or Maximum when 4+ Type 3 teams are also available.</span></div>
      <p class="muted small">Commitment metric (reference only, not in the PL score): ${chip(m.commitment)}</p>`;
  };
  function statusSelect(id, list, i, value, statuses) {
    return `<select class="status" id="${id}" data-list="${list}" data-idx="${i}" data-field="status" data-g="${statusGroup(statuses, value)}">
      ${statuses.map((s) => `<option value="${s.code}" ${s.code === value ? "selected" : ""}>${s.code} – ${esc(s.label)}</option>`).join("")}</select>`;
  }

  /* ---------- Crews ---------- */
  function crewTable(list) {
    const rows = state[list];
    const ooa = list === "ooaCrews";
    const dl = `<datalist id="dl-disp">${C.dispatchCenters.map((d) => `<option value="${d}">`).join("")}</datalist>`;
    if (!rows.length) return `<p class="muted">No ${ooa ? "out-of-area" : "SWA"} crews listed. Use “Add crew”.</p>`;
    return `${dl}<div class="table-wrap"><table>
      <thead><tr><th>Crew</th><th>Type</th><th>Home state</th><th>Home disp.</th><th>Home unit</th><th>Day off</th><th>Status</th><th title="Incident dispatch / GACC, or prepositioned location">Location</th><th>Incident</th><th>Date com.</th><th>Remarks</th><th></th></tr></thead>
      <tbody>${rows.map((c, i) => `<tr>
        <td><input type="text" class="w-m" id="${list}-${i}-name" data-list="${list}" data-idx="${i}" data-field="name" value="${esc(c.name)}"></td>
        <td><select id="${list}-${i}-type" data-list="${list}" data-idx="${i}" data-field="type">${C.crewTypes.map((o) => `<option ${c.type === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
        <td><input type="text" class="w-s" id="${list}-${i}-state" data-list="${list}" data-idx="${i}" data-field="state" value="${esc(c.state)}"></td>
        <td><input type="text" class="w-s" id="${list}-${i}-disp" data-list="${list}" data-idx="${i}" data-field="disp" value="${esc(c.disp)}"></td>
        <td><input type="text" class="w-s" id="${list}-${i}-unit" data-list="${list}" data-idx="${i}" data-field="unit" value="${esc(c.unit)}"></td>
        <td><select id="${list}-${i}-dayoff" data-list="${list}" data-idx="${i}" data-field="dayOff"><option value=""></option>${C.dayOffOptions.map((o) => `<option ${c.dayOff === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
        <td>${statusSelect(`${list}-${i}-status`, list, i, c.status, C.crewStatuses)}</td>
        <td><input type="text" class="w-s" list="dl-disp" id="${list}-${i}-loc" data-list="${list}" data-idx="${i}" data-field="location" value="${esc(c.location)}" placeholder="${c.status === "P" ? "SWCC?" : ""}"></td>
        <td><input type="text" class="w-m" id="${list}-${i}-inc" data-list="${list}" data-idx="${i}" data-field="incident" value="${esc(c.incident)}"></td>
        <td><input type="date" id="${list}-${i}-date" data-list="${list}" data-idx="${i}" data-field="dateCom" value="${esc(c.dateCom)}"></td>
        <td><input type="text" class="w-l" id="${list}-${i}-rem" data-list="${list}" data-idx="${i}" data-field="remarks" value="${esc(c.remarks)}"></td>
        <td><button class="btn icon" data-act="del-row" data-list="${list}" data-idx="${i}" aria-label="Remove ${esc(c.name)}">✕</button></td>
      </tr>`).join("")}</tbody></table></div>`;
  }
  VIEW.crews = () => `
    ${head("T-1 / T2IA Crew Availability", "Crew status comes from the SWCC SharePoint workbook and can be changed here. A crew with status P counts as available only when its location is SWCC. Availability uses an inverted scale: fewer available crews raises the PL.", `<div class="row">${updatedField("crewsUpdated", state.crewsUpdated)}</div>`)}
    ${sourceBar("crews")}
    <section class="panel" id="summary"></section>
    <section class="panel">
      <div class="panel-head"><h3>SWA Type 1 IHC</h3>
        <div class="btn-row">
          <select id="bulk-status" aria-label="Status for all SWA crews">${C.crewStatuses.map((s) => `<option value="${s.code}">${s.code} – ${esc(s.label)}</option>`).join("")}</select>
          <button class="btn" data-act="bulk-ask">Set all SWA crews…</button>
          <button class="btn" data-act="add-crew" data-list="crews">Add crew</button>
        </div></div>
      <div id="bulk-confirm"></div>
      ${crewTable("crews")}
    </section>
    <section class="panel">
      <div class="panel-head"><h3>OOA Type 1 IHC in SWA</h3><button class="btn" data-act="add-crew" data-list="ooaCrews">Add crew</button></div>
      ${crewTable("ooaCrews")}
    </section>`;
  SUMMARY.crews = () => {
    const c = result.crews;
    const counts = C.crewStatuses.filter((s) => c.swa.byStatus[s.code] || c.ooa.byStatus[s.code])
      .map((s) => `<span class="tag" title="${esc(s.label)}">${s.code}: ${c.swa.byStatus[s.code]}${c.ooaTotal ? ` + ${c.ooa.byStatus[s.code]} OOA` : ""}</span>`).join(" ");
    return `<div class="panel-head"><h3>Total Crew Availability metric</h3>${chip(c.rating, true, true)}</div>
      <div class="stats">
        <div class="stat"><span class="k">SWA crews</span><span class="v">${c.swaTotal}</span></div>
        <div class="stat"><span class="k">SWA available</span><span class="v">${c.swa.available} <small>+ ${c.swa.prepoSWCC} prepo SWCC</small></span></div>
        <div class="stat"><span class="k">OOA counted</span><span class="v">${c.ooaAvail} <small>of ${c.ooaTotal}</small></span></div>
        <div class="stat"><span class="k">Committed in SWA</span><span class="v">${c.swa.committed} <small>${pct(c.commitRatio)}</small></span></div>
        <div class="stat"><span class="k">Available ÷ SWA crews</span><span class="v">${pct(c.ratio)} <small>${c.totalAvail}/${c.swaTotal}</small></span></div>
      </div>
      <div class="metric" data-r="${sev(c.rating, true)}"><span class="label">Total availability ${chip(c.rating, false, true)}</span>
        <span class="muted small">SWA only: ${chip(c.swaRating, false, true)}</span>
        <span class="why">Available = A, AG, AD, plus P at SWCC${C.crewAvailability.includeOOAAvailable ? ", for SWA and OOA crews" : "; OOA crews count only when prepositioned at SWCC"}. Ratio ≥ 100% → Maximum · &gt;60% High · &gt;39% Moderate · &gt;11% Low · otherwise Minimum.</span></div>
      <div class="legend">${counts || `<span class="muted">No crews listed.</span>`}</div>`;
  };

  /* ---------- automatic data: shared source strip ---------- */
  const pullStatus = { outlook: "", danger: "" };
  function sourceBar(kind) {
    const sp = C.autoData.sharepoint;
    const src = { outlook: state.outlook, crews: state.crewsSource || {}, imts: state.imtsSource || {} }[kind];
    const label = { outlook: "Pull latest from NPSG" }[kind];
    const link = { crews: sp.crewsUrl, imts: sp.imtUrl }[kind];
    const auto = /auto/i.test(src.source || "");
    const sheetNote = src.lastUpdate ? `<div class="muted small">SharePoint sheet “Last Update”: ${esc(src.lastUpdate)}${src.ooaLastUpdate ? ` · OOA tab: ${esc(src.ooaLastUpdate)}` : ""}</div>` : "";
    const sched = kind === "crews" || kind === "imts" ? `<div class="muted small">The scheduled job reads the SharePoint workbook at 8 AM and 9 PM Mountain. Edits here stay in this browser until the next pull.</div>` : "";
    return `<div class="source-bar${auto ? " is-auto" : ""}">
      <div class="src-text"><span class="k">Data source</span>
        <b>${esc(src.source || "Manual entry")}</b>${src.fetchedAt ? `<span class="muted"> · pulled ${fmtDate(src.fetchedAt, true)}</span>` : ""}
        ${sheetNote}${sched}</div>
      <div class="btn-row">${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open source</a>` : ""}${label ? `<button class="btn primary" data-act="pull-${kind}">${label}</button>` : ""}</div>
      <p class="pull-status small" id="pull-status-${kind}" role="status">${pullStatus[kind] || ""}</p>
    </div>`;
  }
  function setPullStatus(kind, msg, tone) {
    pullStatus[kind] = msg ? `<span class="${tone || ""}">${msg}</span>` : "";
    const el = $(`#pull-status-${kind}`); if (el) el.innerHTML = pullStatus[kind];
  }

  /* ---------- 7-Day ---------- */
  function dayDates() {
    const d0 = parseDate(state.outlook.startDate) || new Date();
    return Array.from({ length: 7 }, (_, i) => new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i));
  }
  const dayHead = (d) => `${d.toLocaleDateString("en-US", { weekday: "short" })}<br>${d.getMonth() + 1}/${d.getDate()}`;
  VIEW.outlook = () => {
    const days = dayDates();
    return `
    ${head("7-Day Significant Fire Potential", "Pulled from the NPSG 7-Day product. Each day's risk score is the sum of all PSA levels; the 7-day average sets the rating. Click any cell to override it (or focus it and type 1–4).",
      `<div class="row"><label class="field"><span>Product date (Day 1)</span><input type="date" id="f-outlook-date" data-path="outlook.startDate" data-rerender value="${esc(state.outlook.startDate)}"></label></div>`)}
    ${sourceBar("outlook")}
    <section class="panel" id="summary"></section>
    <section class="panel">
      <div class="panel-head"><h3>PSA risk by day</h3>
        <div class="legend">${C.outlook.levels.map((l) => `<span><i style="background:var(--sf${l.value})"></i>${l.value} ${esc(l.label)}</span>`).join("")}</div></div>
      <div class="table-wrap"><table class="sf-table">
        <thead><tr><th>PSA</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join("")}</tr></thead>
        <tbody>${C.psas.map((p) => `<tr><td><span class="psa-id">${p.id}</span><div class="psa-name">${esc(p.name)}</div></td>
          ${days.map((_, d) => { const v = (state.outlook.values[p.id] || [])[d] ?? 1;
            return `<td class="sf"><button class="sf-cell" data-psa="${p.id}" data-day="${d}" data-v="${v}" aria-label="${p.id} day ${d + 1}: level ${v}">${v}</button></td>`; }).join("")}</tr>`).join("")}
        </tbody></table></div>
      ${(state.outlook.missing || []).length ? `<p class="warn small">NPSG had no value for ${state.outlook.missing.length} PSA-day${state.outlook.missing.length > 1 ? "s" : ""} (${esc(state.outlook.missing.slice(0, 6).join(", "))}${state.outlook.missing.length > 6 ? "…" : ""}); those cells were set to 1.</p>` : ""}
      <div class="row">
        <label class="field"><span>Set every cell to</span><select id="sf-fill">${C.outlook.levels.map((l) => `<option value="${l.value}">${l.value} ${esc(l.label)}</option>`).join("")}</select></label>
        <button class="btn" data-act="sf-fill">Apply to all</button>
      </div>
      <details class="help"><summary>Paste from the 7-Day product</summary>
        <p class="muted small">Paste rows like the <em>SW_7-Day_ingest</em> sheet: PSA, date, D0–D7 (tab, comma or space separated). With 8 day values, D1–D7 are used, matching the spreadsheet. The date sets the product date.</p>
        <textarea id="paste-7day" placeholder="SW01	11/3/2026	1	1	1	2	2	1	1	1"></textarea>
        <div class="btn-row"><button class="btn primary" data-act="paste-7day">Import rows</button></div>
      </details>
      <details class="help"><summary>PSA reference map</summary><img src="assets/psa-map.png" alt="Map of Southwest Area Predictive Service Areas SW01 through SW14S" loading="lazy"></details>
    </section>`;
  };
  SUMMARY.outlook = () => {
    const o = result.outlook;
    const days = dayDates();
    const n = C.psas.length;
    const avgCount = (lvl) => fmt2(o.daily.reduce((a, d) => a + d.counts[lvl], 0) / 7);
    return `<div class="panel-head"><h3>PSA count by risk level</h3><span class="row" style="align-items:center;gap:8px">7-day average <b>${fmt2(o.avg)}</b> ${chip(o.rating, true)}</span></div>
      <div class="table-wrap"><table class="count-table">
        <thead><tr><th>PSA count</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join("")}<th class="num">7-Day avg</th></tr></thead>
        <tbody>
          ${C.outlook.levels.map((l) => `<tr class="lv lv${l.value}"><td>${esc(l.label)}</td>${o.daily.map((d) => `<td class="num">${d.counts[l.value]}</td>`).join("")}<td class="num">${avgCount(l.value)}</td></tr>`).join("")}
          <tr class="total-row"><td>Risk score</td>${o.daily.map((d) => `<td class="num">${d.score}</td>`).join("")}<td class="num">${fmt2(o.avg)}</td></tr>
          <tr><td>PL rating</td>${o.daily.map((d) => `<td class="num"><span class="chip" data-r="${d.rating}">${d.rating.slice(0, 3).toUpperCase()}</span></td>`).join("")}<td class="num">${chip(o.rating)}</td></tr>
        </tbody></table></div>
      <figure class="chart">${outlookChart(o, days)}</figure>
      <p class="muted small">Rating lines: Low ${C.outlook.bands[0].below} · Moderate ${C.outlook.bands[1].below} · High ${C.outlook.bands[2].below} · Maximum ${C.outlook.bands[3].below}. With ${n} PSAs the score runs ${n} (all little/no risk) to ${n * 4} (all high risk).</p>`;
  };
  /* Mirrors the PL_worksheet chart: daily rating line against the Low / Mod / High / Max lines. */
  function outlookChart(o, days) {
    const W = 760, H = 300, L = 44, R = 20, T = 40, B = 64;
    const lo = C.psas.length, hi = C.psas.length * 4;
    const x = (i) => L + 24 + (i * (W - L - R - 48)) / 6;
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = []; for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) ticks.push(v);
    const grid = ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const lines = [["Low", C.outlook.bands[0].below, "var(--ln-low)"], ["Mod", C.outlook.bands[1].below, "var(--ln-mod)"],
      ["High", C.outlook.bands[2].below, "var(--ln-high)"], ["Max", C.outlook.bands[3].below, "var(--ln-max)"]];
    const th = lines.map(([, v, c]) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${c}" stroke-width="3"/>`).join("");
    const pts = o.daily.map((d, i) => `${x(i)},${y(d.score)}`).join(" ");
    const dots = o.daily.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.score)}" r="4.5" fill="var(--ink)"><title>${days[i].toLocaleDateString("en-US")}: ${d.score} (${d.rating})</title></circle>`).join("");
    const vals = o.daily.map((d, i) => `<text x="${x(i)}" y="${y(d.score) - 10}" text-anchor="middle" class="val">${d.score}</text>`).join("");
    const xt = days.map((d, i) => `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}</text>`).join("");
    const legendItems = [["Daily rating", "var(--ink)"], ...lines.map(([n, , c]) => [n, c])];
    let lx = W / 2 - 230;
    const legend = legendItems.map(([n, c]) => { const s = `<line x1="${lx}" x2="${lx + 24}" y1="${H - 16}" y2="${H - 16}" stroke="${c}" stroke-width="3"/><text x="${lx + 30}" y="${H - 12}">${n}</text>`; lx += n.length * 7 + 56; return s; }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Southwest Area daily significant fire potential rating for the 7-day period">
      <text x="${W / 2}" y="20" text-anchor="middle" class="title">Southwest Area Daily Significant Fire Potential Rating</text>
      ${grid}${th}<polyline points="${pts}" fill="none" stroke="var(--ink)" stroke-width="2.5" stroke-linejoin="round"/>${dots}${vals}${xt}${legend}</svg>`;
  }

  /* ---------- PSA ERCy ---------- */
  const binOf = (v) => { const n = parseFloat(v); if (!Number.isFinite(n)) return ""; return n < 50 ? 0 : n < 90 ? 1 : n < 97 ? 2 : 3; };
  const showVal = (v) => (v === "" || v === undefined || v === null ? "" : Math.round(parseFloat(v) * 10) / 10);
  let lastImport = null;
  VIEW.danger = () => `
    ${head("PSA ERCy Values (observed fire danger)", "ERCy and BIy value and percentile for each PSA. Upload the day's ERC/BI file, paste rows, or type values in. The PL uses the ERCy percentiles; BIy is recorded for reference.",
      `<div class="row"><label class="field"><span>Updated</span><input type="date" id="f-erc-date" data-path="danger.date" value="${esc(state.danger.date)}"></label></div>`)}
    <section class="panel upload-panel">
      <div class="upload-row">
        <label class="dropzone" id="erc-drop" for="erc-file">
          <input type="file" id="erc-file" accept=".xlsx,.xlsm,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
          <span class="dz-title">Upload ERC/BI file</span>
          <span class="muted small">Drop an .xlsx or .csv here, or click to choose one</span>
        </label>
        <div class="src-text">
          <p><span class="k">Data source</span> <b>${esc(state.danger.source || "Manual entry")}</b>${state.danger.fetchedAt ? `<span class="muted"> · loaded ${fmtDate(state.danger.fetchedAt, true)}</span>` : ""}</p>
          <p class="muted small">The file needs a PSA column (SW01 … SW14N) and ERC and/or BI columns, such as <em>PSA Avg, ERCy Avg, BI Avg, ERCy Percentile, BI Percentile, ObsDate</em>. Several rows per PSA (stations) are averaged using each PSA's latest date.</p>
          <p class="muted small">Uploading here changes this browser only. To update the site for everyone, upload the file to the repository's <b>uploads</b> folder.</p>
          <div id="erc-import-result">${lastImport || ""}</div>
        </div>
      </div>
    </section>
    <div class="grid-2 erc-layout">
      <section class="panel">
        <div class="panel-head"><h3>PSA ERCy values</h3><span class="muted small">Updated ${fmtDate(state.danger.date)}</span></div>
        <div class="table-wrap"><table class="erc-table">
          <thead><tr><th>PSA</th><th>Description</th><th class="num">ERCy perc</th><th class="num">ERCy val</th><th class="num">BIy perc</th><th class="num">BIy val</th></tr></thead>
          <tbody>${C.psas.map((p) => { const r = state.danger.rows[p.ercId] || {}; const k = p.ercId; return `<tr>
            <td class="psa-id">${k}</td><td class="psa-name">${esc(p.name)}</td>
            <td class="pct"><input type="number" min="0" max="100" id="erc-${k}-pct" data-erc="${k}" data-field="ercPct" data-bin="${binOf(r.ercPct)}" value="${esc(showVal(r.ercPct))}" aria-label="${k} ERCy percentile"></td>
            <td class="num"><input type="number" step="0.1" id="erc-${k}-val" data-erc="${k}" data-field="ercVal" value="${esc(showVal(r.ercVal))}" aria-label="${k} ERCy value"></td>
            <td class="pct"><input type="number" min="0" max="100" id="erc-${k}-bipct" data-erc="${k}" data-field="biPct" data-bin="${binOf(r.biPct)}" value="${esc(showVal(r.biPct))}" aria-label="${k} BIy percentile"></td>
            <td class="num"><input type="number" step="0.1" id="erc-${k}-bival" data-erc="${k}" data-field="biVal" value="${esc(showVal(r.biVal))}" aria-label="${k} BIy value"></td></tr>`; }).join("")}
          </tbody></table></div>
        <details class="help"><summary>Paste rows instead</summary>
          <p class="muted small">Paste rows like the <em>NFDRSy_Ingest</em> sheet, with or without the header row: PSA, ERCy avg, BI avg, ERCy percentile, BI percentile, ObsDate.</p>
          <textarea id="paste-nfdrs" placeholder="SW-01	9	8	45	45	11/3/2026"></textarea>
          <div class="btn-row"><button class="btn primary" data-act="paste-nfdrs">Import rows</button></div>
        </details>
      </section>
      <section class="panel" id="summary"></section>
    </div>`;
  SUMMARY.danger = () => {
    const d = result.danger;
    const n = d.count;
    const bins = [["<50th percentile", "below50", 0], ["50th–89th percentile", "p50to89", 1], ["90th–96th percentile", "p90to96", 2], ["97th+ percentile", "p97plus", 3]];
    const row = ([label, k, b]) => `<tr><td>${label}</td><td class="num bin" data-bin="${b}">${d.bins[k]}</td><td class="num">${pct(d.bins[k] / n)}</td><td class="num bin" data-bin="${b}">${d.biBins[k]}</td><td class="num">${pct(d.biBins[k] / n)}</td></tr>`;
    return `<div class="panel-head"><h3>Fire Danger Metric</h3>${chip(d.rating, true)}</div>
      <div class="table-wrap"><table class="bin-table">
        <thead><tr><th></th><th class="num">PSA count<br>ERCy perc</th><th class="num">% of PSAs<br>ERCy</th><th class="num">PSA count<br>BI-y</th><th class="num">% of PSAs<br>BI-y</th></tr></thead>
        <tbody>${bins.map(row).join("")}
          <tr class="total-row"><td>50th and up</td><td class="num">${d.above50}</td><td class="num">${pct(d.above50 / n)}</td><td></td><td></td></tr></tbody></table></div>
      ${d.bins.missing ? `<p class="warn">${d.bins.missing} PSA${d.bins.missing > 1 ? "s have" : " has"} no ERCy percentile and ${d.bins.missing > 1 ? "are" : "is"} left out.</p>` : ""}
      <div class="metric" data-r="${d.rating}"><span class="label">Fire Danger Metric ${chip(d.rating)}</span>
        <span class="why">${C.danger.extremeCount}+ PSAs at 97th+ → Extreme · any PSA at 97th+ → High · any at 90th–96th → Moderate · any at 50th–89th → Low · otherwise Minimum.</span></div>`;
  };
  function applyErcImport(res, label) {
    const rows = {};
    for (const p of C.psas) {
      const r = res.rows[p.ercId];
      rows[p.ercId] = r ? { ercVal: r.ercVal, biVal: r.biVal, ercPct: r.ercPct, biPct: r.biPct } : { ercVal: "", biVal: "", ercPct: "", biPct: "" };
    }
    state.danger = { date: res.date || todayIso(), rows, source: label, fetchedAt: nowLocal() };
    const got = Object.keys(res.rows).length;
    const avg = Object.values(res.rows).some((r) => r.rowsUsed > 1);
    const noPct = !res.columns.includes("ercPct");
    lastImport = `<p class="import-ok small">Loaded ${got} of ${C.psas.length} PSAs from ${res.rowsRead} row${res.rowsRead > 1 ? "s" : ""}${res.sheet ? ` on sheet “${esc(res.sheet)}”` : ""}${res.date ? `, dated ${fmtDate(res.date)}` : ""}${avg ? "; several rows per PSA were averaged" : ""}.</p>`
      + (res.missing.length ? `<p class="warn small">No values for ${esc(res.missing.join(", "))}.</p>` : "")
      + (noPct ? `<p class="warn small">The file has no ERCy percentile column, so the Fire Danger Metric can't be rated until percentiles are entered.</p>` : "");
    save(); renderView(); toast(`ERC/BI loaded: ${got} PSAs`);
  }
  async function importErcFile(file) {
    if (!file) return;
    const box = $("#erc-import-result");
    if (box) box.innerHTML = `<p class="muted small">Reading ${esc(file.name)}…</p>`;
    try {
      const res = await ErcImport.importFile(new Uint8Array(await file.arrayBuffer()), file.name);
      applyErcImport(res, `Uploaded file ${file.name}`);
    } catch (e) {
      lastImport = `<p class="warn small">${esc(file.name)}: ${esc(e.message)}</p>`;
      if (box) box.innerHTML = lastImport;
    }
  }
  function pasteNfdrs(text) {
    try { applyErcImport(ErcImport.parseRows(ErcImport.parseCsv(text.replace(/ {2,}/g, "\t"))), "Pasted rows"); }
    catch (e) { toast("No PSA rows found. Check the format."); }
  }

  /* ---------- History & Data ---------- */
  const archive = { loaded: false, history: [], daily: [], raws: [], error: "", groupBy: "pl" };
  async function loadArchive() {
    if (archive.loaded) return;
    archive.loaded = true;
    if (window.PL_ARCHIVE) { Object.assign(archive, window.PL_ARCHIVE); return; }
    const get = async (f) => {
      try { const r = await fetch(`data/archive/${f}`, { cache: "no-store" }); if (!r.ok) return []; return csvObjects(await r.text()); }
      catch (e) { return []; }
    };
    [archive.history, archive.daily, archive.raws] = await Promise.all([get("history.csv"), get("fire_starts_daily.csv"), get("raws_daily.csv")]);
  }
  function csvObjects(text) {
    const rows = ErcImport.parseCsv(text).filter((r) => r.length > 1);
    if (!rows.length) return [];
    const [h, ...rest] = rows;
    return rest.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ""])));
  }
  const n0 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  /* One record per day: the morning (AM) run's PL for that day, joined with that day's new starts. */
  function joinedDays() {
    const byDay = {};
    for (const h of archive.history) {
      const d = h.run_date, cur = byDay[d];
      if (!cur || (cur.run_slot !== "AM" && h.run_slot === "AM") || (cur.run_slot === h.run_slot && h.run_time < cur.run_time)) byDay[d] = h;
    }
    const starts = Object.fromEntries(archive.daily.map((d) => [d.date, d]));
    const dates = [...new Set([...Object.keys(byDay), ...Object.keys(starts)])].sort();
    return dates.map((date) => ({ date, run: byDay[date] || null, starts: starts[date] || null }));
  }

  VIEW.history = () => `
    ${head("History &amp; Data", "Every scheduled run is archived. Each day's new fire starts (WFIGS) and RAWS weather are kept alongside that day's PL, building a record to check whether the PL calculation tracks real fire activity.")}
    <div class="grid-2">
      <section class="panel">${yesterdayStarts()}</section>
      <section class="panel">${yesterdayRaws()}</section>
    </div>
    <section class="panel" id="summary"><p class="muted">Loading the archive…</p></section>`;
  AFTER.history = [async () => {
    if (archive.loaded) return;
    await loadArchive();
    if (view === "history") { const s = $("#summary"); if (s) s.innerHTML = SUMMARY.history(); }
  }];

  function yesterdayStarts() {
    const f = state.fireStarts;
    if (!f || !f.daily) return `<h3>New fire starts</h3><p class="muted">Fire starts appear after the first scheduled run (from WFIGS incident locations).</p>`;
    const y = f.daily[f.to] || { total: 0, lightning: 0, human: 0, unknown: 0, acres: 0, byPsa: {} };
    const week = Object.entries(f.daily).sort(([a], [b]) => a.localeCompare(b));
    const psaRows = C.psas.filter((p) => (y.byPsa[p.ercId] || {}).total).map((p) => { const b = y.byPsa[p.ercId];
      return `<tr><td class="psa-id">${p.id}</td><td class="psa-name">${esc(p.name)}</td><td class="num">${b.total}</td><td class="num">${b.lightning}</td><td class="num">${b.human}</td><td class="num">${b.unknown}</td></tr>`; }).join("");
    return `<div class="panel-head"><h3>New fire starts · ${fmtDate(f.to)}</h3><span class="muted small">${esc(f.source || "")}${f.fetchedAt ? ` · pulled ${fmtDate(f.fetchedAt, true)}` : ""}</span></div>
      <div class="stats">
        <div class="stat"><span class="k">Total</span><span class="v">${y.total}</span></div>
        <div class="stat cause-l"><span class="k">Lightning</span><span class="v">${y.lightning}</span></div>
        <div class="stat cause-h"><span class="k">Human</span><span class="v">${y.human}</span></div>
        <div class="stat cause-u"><span class="k">Unknown</span><span class="v">${y.unknown}</span></div>
        <div class="stat"><span class="k">Acres</span><span class="v">${y.acres}</span></div>
      </div>
      ${psaRows ? `<div class="table-wrap"><table><thead><tr><th>PSA</th><th>Description</th><th class="num">Starts</th><th class="num">Lightning</th><th class="num">Human</th><th class="num">Unknown</th></tr></thead><tbody>${psaRows}</tbody></table></div>` : ""}
      <p class="muted small">Last 7 days: ${week.map(([d, s]) => `${d.slice(5).replace("-", "/")} <b>${s.total}</b>`).join(" · ")}. Recent days are re-counted each run because reports arrive late.</p>`;
  }
  function yesterdayRaws() {
    const w = state.raws || {}, nf = state.femsNfdr || {};
    if (!w.byPsa && !nf.byPsa) return `<h3>RAWS</h3><p class="muted">RAWS summaries appear after the first scheduled run (FEMS weather observations from every RAWS in each PSA).</p>`;
    const rows = C.psas.map((p) => { const x = (w.byPsa || {})[p.ercId] || {}, n = (nf.byPsa || {})[p.ercId] || {};
      return `<tr><td class="psa-id">${p.id}</td><td class="num">${x.stationsListed ? `${x.stations}/${x.stationsListed}` : x.stations ?? ""}</td><td class="num">${x.avgMaxTemp ?? ""}</td><td class="num">${x.avgMinRh ?? ""}</td><td class="num">${x.lowestRh ?? ""}</td><td class="num">${x.maxGust ?? ""}</td><td class="num">${x.avgPrecip ?? ""}</td><td class="num">${x.wettingRain ?? ""}</td><td class="num">${n.erc ?? ""}</td><td class="num">${n.bi ?? ""}</td></tr>`; }).join("");
    return `<div class="panel-head"><h3>RAWS · ${fmtDate(w.date || nf.date)}</h3><span class="muted small">FEMS: weather from every RAWS in the PSA; ERC-Y/BI-Y at 13:00 from the SWCC station list (archive only)</span></div>
      <div class="table-wrap"><table class="raws-table"><thead><tr><th>PSA</th><th class="num" title="Stations reporting / listed">Stns</th><th class="num">Max °F (avg)</th><th class="num">Min RH % (avg)</th><th class="num">Lowest RH %</th><th class="num">Max gust mph</th><th class="num">Precip in (avg)</th><th class="num">Wetting rain stns</th><th class="num">ERC-Y</th><th class="num">BI-Y</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  SUMMARY.history = () => {
    if (!archive.loaded) return `<p class="muted">Loading the archive…</p>`;
    const days = joinedDays();
    if (!archive.history.length) return `<h3>Archive</h3><p class="muted">No runs archived yet. The archive starts with the first scheduled run (8 AM or 9 PM Mountain) or a manual “Run workflow”, and grows by two rows a day.</p>${downloads()}`;
    return `${archive.example ? `<p class="warn small">Example data for this preview. The real archive fills in from the scheduled runs.</p>` : ""}
      <div class="panel-head"><h3>PL score and new fire starts</h3><span class="legend"><span><i style="background:var(--ink)"></i>PL score (morning run)</span><span><i style="background:var(--c-light)"></i>Lightning</span><span><i style="background:var(--c-human)"></i>Human</span><span><i style="background:var(--c-unk)"></i>Unknown</span></span></div>
      <figure class="chart">${historyChart(days.slice(-60))}</figure>
      ${calibration(days)}
      ${recentRuns()}
      ${downloads()}`;
  };
  function historyChart(days) {
    if (!days.length) return "";
    const W = 760, H = 280, L = 44, R = 44, T = 30, B = 34;
    const n = days.length, bw = Math.max(2, ((W - L - R) / n) * 0.7);
    const x = (i) => L + ((i + 0.5) * (W - L - R)) / n;
    const maxS = Math.max(4, ...days.map((d) => n0(d.starts && d.starts.total) || 0));
    const ys = (v) => T + (1 - v / maxS) * (H - T - B), yp = (v) => T + (1 - v) * (H - T - B);
    const bands = C.plLevels.map((l, i) => { const top = (C.plLevels[i + 1] || { min: 1 }).min;
      return `<rect x="${L}" width="${W - L - R}" y="${yp(top)}" height="${yp(l.min) - yp(top)}" fill="var(--pl${l.pl})" opacity=".08"/>`; }).join("");
    const bars = days.map((d, i) => { if (!d.starts) return "";
      let y0 = H - B; const parts = [["lightning", "var(--c-light)"], ["human", "var(--c-human)"], ["unknown", "var(--c-unk)"]];
      return parts.map(([k, c]) => { const v = n0(d.starts[k]) || 0; if (!v) return ""; const h = (H - T - B) * (v / maxS); y0 -= h;
        return `<rect x="${x(i) - bw / 2}" y="${y0}" width="${bw}" height="${h}" fill="${c}"><title>${d.date}: ${v} ${k}</title></rect>`; }).join(""); }).join("");
    const pts = days.map((d, i) => (d.run ? `${x(i)},${yp(n0(d.run.score) || 0)}` : null)).filter(Boolean);
    const line = pts.length > 1 ? `<polyline points="${pts.join(" ")}" fill="none" stroke="var(--ink)" stroke-width="2"/>` : "";
    const dots = days.map((d, i) => (d.run ? `<circle cx="${x(i)}" cy="${yp(n0(d.run.score) || 0)}" r="3" fill="var(--ink)"><title>${d.date}: PL${d.run.pl} (${d.run.score})</title></circle>` : "")).join("");
    const yl = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${L - 6}" y="${yp(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const yr = [0, Math.round(maxS / 2), maxS].map((v) => `<text x="${W - R + 6}" y="${ys(v) + 4}">${v}</text>`).join("");
    const step = Math.ceil(n / 8);
    const xl = days.map((d, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${+d.date.slice(5, 7)}/${+d.date.slice(8)}</text>` : "")).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PL score and daily new fire starts">${bands}${bars}${line}${dots}${yl}${yr}${xl}
      <text x="4" y="14" class="axis">PL score</text><text x="${W - R + 6}" y="14" class="axis">Starts</text></svg>`;
  }
  function calibration(days) {
    const groups = {
      pl: { label: "PL", key: (r) => `PL${r.pl}`, order: ["PL1", "PL2", "PL3", "PL4", "PL5"] },
      fire_rating: { label: "Fire Activity rating", key: (r) => r.fire_rating },
      imt_rating: { label: "IMT availability rating", key: (r) => r.imt_rating },
      crews_rating: { label: "Crew availability rating", key: (r) => r.crews_rating },
      outlook_rating: { label: "7-Day trend rating", key: (r) => r.outlook_rating },
      danger_rating: { label: "ERCy rating", key: (r) => r.danger_rating },
    };
    const g = groups[archive.groupBy] || groups.pl;
    const order = g.order || ["Minimum", "Low", "Moderate", "High", "Maximum", "Extreme"];
    const paired = days.filter((d) => d.run && d.starts);
    const by = {};
    for (const d of paired) (by[g.key(d.run)] = by[g.key(d.run)] || []).push(d);
    const avg = (list, k) => (list.reduce((a, d) => a + (n0(d.starts[k]) || 0), 0) / list.length).toFixed(1);
    const rows = order.filter((k) => by[k]).map((k) => { const list = by[k];
      return `<tr><td>${g === groups.pl ? `<b>${k}</b>` : chip(k)}</td><td class="num">${list.length}</td><td class="num"><b>${avg(list, "total")}</b></td><td class="num">${avg(list, "lightning")}</td><td class="num">${avg(list, "human")}</td><td class="num">${avg(list, "unknown")}</td><td class="num">${Math.max(...list.map((d) => n0(d.starts.total) || 0))}</td><td class="num">${avg(list, "acres")}</td></tr>`; }).join("");
    // correlation between morning score and that day's starts
    let r = "";
    if (paired.length >= 5) {
      const xs = paired.map((d) => n0(d.run.score) || 0), ysv = paired.map((d) => n0(d.starts.total) || 0);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ysv.reduce((a, b) => a + b, 0) / ysv.length;
      const cov = xs.reduce((a, v, i) => a + (v - mx) * (ysv[i] - my), 0), vx = xs.reduce((a, v) => a + (v - mx) ** 2, 0), vy = ysv.reduce((a, v) => a + (v - my) ** 2, 0);
      if (vx && vy) r = (cov / Math.sqrt(vx * vy)).toFixed(2);
    }
    return `<div class="panel-head"><h3>Does the PL track fire activity?</h3>
        <label class="field row-inline"><span>Group days by</span><select id="hist-group">${Object.entries(groups).map(([k, v]) => `<option value="${k}" ${k === archive.groupBy ? "selected" : ""}>${v.label}</option>`).join("")}</select></label></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>${esc(g.label)}</th><th class="num">Days</th><th class="num">Avg starts/day</th><th class="num">Lightning</th><th class="num">Human</th><th class="num">Unknown</th><th class="num">Most in a day</th><th class="num">Avg acres/day</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">Needs days that have both a morning run and a fire-start count.</p>`}
      <p class="muted small">${paired.length} day${paired.length === 1 ? "" : "s"} with both a morning PL and fire starts.${r !== "" ? ` Correlation between the morning PL score and that day's starts: <b>${r}</b> (1 = moves together, 0 = no relation).` : " A correlation appears after 5 such days."} If higher PLs don't line up with more starts over a season, the weights or thresholds in <code>js/config.js</code> are worth revisiting.</p>`;
  }
  function recentRuns() {
    const rows = archive.history.slice(-14).reverse().map((h) => `<tr><td>${fmtDate(h.run_time, true)}</td><td><span class="pl-mini" data-pl="${h.pl}">PL${h.pl}</span></td><td class="num">${(+h.score).toFixed(3)}</td>
      <td>${chip(h.fire_rating)}</td><td>${chip(h.imt_rating, false, true)}</td><td>${chip(h.crews_rating, false, true)}</td><td>${chip(h.outlook_rating)}</td><td>${chip(h.danger_rating)}</td>
      <td class="num">${h.starts_total || "–"}</td><td>${h.snapshot && !archive.example ? `<a href="${esc(h.snapshot)}" target="_blank" rel="noopener">data</a>` : ""}</td></tr>`).join("");
    return `<h3>Recent runs</h3><div class="table-wrap"><table><thead><tr><th>Run</th><th>PL</th><th class="num">Score</th><th>Fire</th><th>IMTs</th><th>Crews</th><th>7-Day</th><th>ERCy</th><th class="num">Starts (prev. day)</th><th>Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function downloads() {
    const files = [["history.csv", "Every run: PL, score, each element's rating and inputs, previous-day starts and RAWS"],
      ["fire_starts_daily.csv", "New starts per day by cause, acres, and per PSA"], ["fire_starts.csv", "Every fire: date, cause, acres, PSA, location"],
      ["raws_daily.csv", "RAWS per day and PSA: max temp, min RH, max gust, precip"],
      ["fems_erc_bi_daily.csv", "FEMS fuel model Y ERC and BI per day and PSA (13:00 reading and daily max)"],
      ["fems_erc_bi_stations.csv", "The same per station, for the SWCC ERC station list"]];
    return `<h3>Download the database</h3><ul class="dl-list">${files.map(([f, d]) => `<li><a href="data/archive/${f}" download>${f}</a> <span class="muted small">${d}</span></li>`).join("")}</ul>
      <p class="muted small">Snapshots of every run are in <code>data/archive/snapshots/</code> in the repository. The CSVs open in Excel.</p>`;
  }

  /* ---------- Model & Data ---------- */
  VIEW.model = () => {
    const custom = state.preset === "custom";
    const w = calc.weightsFor(state);
    return `
    ${head("Model &amp; Data", "Choose element weights, move data in and out, and see how the PL is calculated.")}
    <div class="grid-2">
      <section class="panel">
        <h3>Element weights</h3>
        <div class="rating-cards">
          ${Object.entries(C.weightPresets).map(([k, p]) => `<label class="rating-card"><input type="radio" name="preset" id="preset-${k}" data-path="preset" data-rerender value="${k}" ${state.preset === k ? "checked" : ""}>
            <span class="t" style="color:var(--ink)">${esc(p.label)}</span><p>${C.elements.map((e) => `${esc(e.name)} ${fmt2(p.weights[e.key])}`).join(" · ")}<br><span class="small">${esc(p.source)}</span></p></label>`).join("")}
          <label class="rating-card"><input type="radio" name="preset" id="preset-custom" data-path="preset" data-rerender value="custom" ${custom ? "checked" : ""}>
            <span class="t" style="color:var(--ink)">Custom weights</span><p>Set each element's maximum contribution below.</p></label>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Element</th><th class="num">Max contribution</th></tr></thead><tbody>
          ${C.elements.map((e) => `<tr><td>${esc(e.name)}</td><td class="num"><input type="number" step="0.05" min="0" max="1" id="w-${e.key}" data-path="weights.${e.key}" data-num value="${w[e.key]}" ${custom ? "" : "disabled"}></td></tr>`).join("")}
        </tbody></table></div>
        <div id="summary"></div>
      </section>
      <section class="panel">
        <h3>Save and share data</h3>
        <p class="muted small">Your edits are saved automatically in this browser. To share a PL with others, download the data file and commit it to the repository as <code>data/current.json</code>. Everyone opening the site then starts from it.</p>
        <div class="btn-row">
          <button class="btn primary" data-act="export">Download data file</button>
          <button class="btn" data-act="copy-json">Copy data as JSON</button>
          <label class="btn" for="import-file">Open data file…</label>
          <input type="file" id="import-file" accept=".json,application/json" hidden>
        </div>
        <div class="btn-row">
          <button class="btn danger" data-act="reset-ask" ${published ? "" : "disabled"}>Discard my edits, reload published data</button>
        </div>
        <div id="reset-confirm"></div>
        <details class="help"><summary>How the PL is calculated</summary>
          <div class="prose small">
            <p>Each element is rated Minimum, Low, Moderate, High or Maximum (ERCy can also be Extreme). The rating maps to a multiplier:</p>
            <ul><li>Fire Activity, 7-Day trend, ERCy: Minimum 0 · Low 0.25 · Moderate 0.5 · High 0.75 · Maximum/Extreme 1</li>
              <li>IMT and crew availability (inverted): Maximum 0 · High 0.25 · Moderate 0.5 · Low 0.75 · Minimum 1</li></ul>
            <p>Contribution = weight × multiplier. The PL score is the sum of contributions:</p>
            <ul>${C.plLevels.map((l, i) => `<li>PL${l.pl}: ${i ? `${l.min} and up` : "0"}${C.plLevels[i + 1] ? ` to below ${C.plLevels[i + 1].min}` : " to 1.0"}</li>`).join("")}</ul>
            <p>Thresholds, rosters and status codes are set in <code>js/config.js</code>.</p>
          </div>
        </details>
      </section>
    </div>`;
  };
  SUMMARY.model = () => {
    const t = result.weightTotal;
    return Math.abs(t - 1) > 0.001 ? `<p class="warn">Weights add up to ${fmt2(t)}. They should add up to 1.00.</p>` : `<p class="muted small">Weights add up to 1.00.</p>`;
  };

  /* ================= EVENTS ================= */
  function stamp(key) {
    const map = { fire: "fire.updated", imts: "imtsUpdated", crews: "crewsUpdated", ooaCrews: "crewsUpdated" };
    if (map[key]) setPath(map[key], nowLocal());
    const f = $(`[data-path="${map[key]}"]`); if (f) f.value = map[key].split(".").reduce((o, k) => o[k], state);
  }
  function onInput(e) {
    const el = e.target;
    if (el.id === "import-file" && e.type === "change") return importFile(el);
    if (el.id === "erc-file" && e.type === "change") { const f = el.files && el.files[0]; el.value = ""; return importErcFile(f); }
    if (el.id === "hist-group") { archive.groupBy = el.value; const s = $("#summary"); if (s) s.innerHTML = SUMMARY.history(); return; }
    if (el.dataset.path) {
      if (el.type === "radio" && !el.checked) return;
      let v = el.value;
      if (el.dataset.num !== undefined) v = v === "" ? "" : parseFloat(v);
      const prevPreset = state.preset;
      setPath(el.dataset.path, v);
      if (el.dataset.path.startsWith("fire.") && el.dataset.path !== "fire.updated") stamp("fire");
      if (el.dataset.path === "preset" && v === "custom" && prevPreset !== "custom") state.weights = calc.weightsFor({ preset: prevPreset });
      save();
      if (el.dataset.rerender !== undefined && e.type === "change") return renderView();
      return refresh();
    }
    if (el.dataset.list && el.dataset.field) {
      const row = state[el.dataset.list][+el.dataset.idx];
      row[el.dataset.field] = el.value;
      if (el.dataset.field === "status") {
        el.dataset.g = statusGroup(el.dataset.list === "imts" ? C.imtStatuses : C.crewStatuses, el.value);
        if (el.value === "P") { const loc = $(`#${el.dataset.list}-${el.dataset.idx}-loc`); if (loc) loc.placeholder = "SWCC?"; }
      }
      stamp(el.dataset.list);
      markEdited(el.dataset.list === "imts" ? "imts" : "crews");
      save(); return refresh();
    }
    if (el.dataset.erc) {
      state.danger.rows[el.dataset.erc] = state.danger.rows[el.dataset.erc] || {};
      state.danger.rows[el.dataset.erc][el.dataset.field] = el.value === "" ? "" : parseFloat(el.value);
      if (el.dataset.bin !== undefined) el.dataset.bin = binOf(el.value);
      markEdited("danger");
      save(); return refresh();
    }
  }
  function markEdited(kind) {
    const o = kind === "outlook" ? state.outlook : kind === "danger" ? state.danger
      : kind === "imts" ? (state.imtsSource = state.imtsSource || {}) : (state.crewsSource = state.crewsSource || {});
    if (/\(auto\)/.test(o.source || "")) o.source = o.source.replace("(auto)", "(edited by hand)");
    else if (/^(Uploaded file|Pasted rows)/.test(o.source || "") && !/edited/.test(o.source)) o.source += " (edited by hand)";
    else if (!o.source) o.source = "Manual entry";
  }
  function setCell(btn, v) {
    const vals = state.outlook.values[btn.dataset.psa] = state.outlook.values[btn.dataset.psa] || [1, 1, 1, 1, 1, 1, 1];
    vals[+btn.dataset.day] = v;
    markEdited("outlook");
    btn.dataset.v = v; btn.textContent = v;
    btn.setAttribute("aria-label", `${btn.dataset.psa} day ${+btn.dataset.day + 1}: level ${v}`);
    save(); refresh();
  }
  function onKey(e) {
    const btn = e.target.closest && e.target.closest(".sf-cell");
    if (btn && /^[1-4]$/.test(e.key)) { e.preventDefault(); setCell(btn, +e.key); }
  }
  function onClick(e) {
    const cell = e.target.closest(".sf-cell");
    if (cell) return setCell(cell, (+cell.dataset.v % 4) + 1);
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    const A = {
      "use-suggested": () => { state.fire.rating = result.fire.suggested; stamp("fire"); save(); renderView(); },
      "copy-brief": () => copyText(briefText(), $("#f-brief")),
      "print": printBriefing,
      "xlsx": exportXlsx,
      "email": emailDraft,
      "add-imt": () => { state.imts.push({ mob: "SW", type: "CIMT", zone: "", ic: "", home: "", status: "AN", incident: "", dateComm: "", remarks: "" }); save(); renderView(); },
      "add-crew": () => { state[b.dataset.list].push({ name: "", type: "CRW1", state: "", disp: "", unit: "", dayOff: "", status: "A", location: "", incident: "", dateCom: "", remarks: "" }); stamp(b.dataset.list); save(); renderView(); },
      "del-row": () => { state[b.dataset.list].splice(+b.dataset.idx, 1); stamp(b.dataset.list); save(); renderView(); },
      "bulk-ask": () => { const s = $("#bulk-status").value; $("#bulk-confirm").innerHTML = `<div class="confirm">Set all ${state.crews.length} SWA crews to <b>${esc(s)}</b>? <button class="btn danger" data-act="bulk-do" data-s="${esc(s)}">Set all</button><button class="btn" data-act="cancel">Cancel</button></div>`; },
      "bulk-do": () => { state.crews.forEach((c) => (c.status = b.dataset.s)); stamp("crews"); save(); renderView(); toast(`All SWA crews set to ${b.dataset.s}`); },
      "cancel": () => { b.closest(".confirm").remove(); },
      "sf-fill": () => { const v = +$("#sf-fill").value; for (const p of C.psas) state.outlook.values[p.id] = Array(7).fill(v); state.outlook.source = "Manual entry"; state.outlook.fetchedAt = ""; state.outlook.missing = []; save(); renderView(); },
      "pull-outlook": () => pullOutlook(false),
      "paste-7day": () => pasteSevenDay($("#paste-7day").value),
      "paste-nfdrs": () => pasteNfdrs($("#paste-nfdrs").value),
      "export": exportFile,
      "copy-json": () => copyText(JSON.stringify(state, null, 1)),
      "reset-ask": () => { $("#reset-confirm").innerHTML = `<div class="confirm">This replaces everything you've entered in this browser. <button class="btn danger" data-act="reset-do">Discard and reload</button><button class="btn" data-act="cancel">Cancel</button></div>`; },
      "reset-do": () => { try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ } state = normalize(clone(published)); source = "published"; renderView(); toast("Published data loaded"); },
    };
    if (A[act]) { e.preventDefault(); A[act](); }
  }

  /* ---------- import / export ---------- */
  function copyText(text, fallbackEl) {
    const done = () => toast("Copied");
    const fail = () => { if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); toast("Press Ctrl+C to copy"); } else toast("Copy failed"); };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  }
  function exportFile() {
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `swa-pl-${(state.meta.asOf || nowLocal()).slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Data file downloaded");
  }
  function importFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const s = JSON.parse(rd.result);
        if (!s || typeof s !== "object" || !s.outlook) throw new Error("bad");
        state = normalize(s); save(); renderView(); toast(`Loaded ${file.name}`);
      } catch (err) { toast("That file isn't a PL data file"); }
    };
    rd.readAsText(file);
  }
  const splitRow = (line) => line.split(/\t|,|\s{2,}|\s(?=\S)/).map((s) => s.trim()).filter(Boolean);
  function toIsoDate(tok) {
    const d = parseDate(tok);
    return d ? isoDay(d) : null;
  }
  function pasteSevenDay(text) {
    const ids = Object.fromEntries(C.psas.map((p) => [normId(p.id), p.id]));
    let n = 0, date = null;
    for (const line of text.split(/\r?\n/)) {
      const t = splitRow(line);
      if (!t.length || !ids[normId(t[0])]) continue;
      const rest = t.slice(1);
      if (rest.length && toIsoDate(rest[0]) && /[-/]/.test(rest[0])) { date = date || toIsoDate(rest[0]); rest.shift(); }
      const nums = rest.map(Number).filter((v) => Number.isFinite(v));
      const days = nums.length >= 8 ? nums.slice(1, 8) : nums.slice(0, 7);
      if (days.length < 7) continue;
      state.outlook.values[ids[normId(t[0])]] = days.map((v) => Math.max(1, Math.min(4, Math.round(v))));
      n++;
    }
    if (!n) return toast("No PSA rows found. Check the format.");
    if (date) { state.outlook.startDate = date; state.outlook.updated = date; }
    Object.assign(state.outlook, { source: "Pasted 7-Day rows", fetchedAt: "", missing: [] });
    save(); renderView(); toast(`Imported ${n} PSA rows`);
  }


  init();
})();
