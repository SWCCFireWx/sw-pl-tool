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
  const Review = window.PL_REVIEW;
  const NO_PULL = /[?&]nopull\b/.test(location.search);
  const STORE_KEY = "swa-pl-state-v1"; // the new-model site (sw-pl-tool-new) uses its own key on the same github.io address
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
    { id: "review", label: "Season Review" },
    { id: "model", label: "Model & Data" },
    { id: "calc", label: "Calculations" },
    { id: "health", label: "Data Health" },
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
      schema: 1, modelVersion: 2,
      meta: { asOf: nowLocal(), preparedBy: "", notes: "", source: "blank" },
      preset: C.defaultPreset, weights: { ...C.weightPresets[C.defaultPreset].weights },
      fire: { rating: "Minimum", complex: 0, t3: 0, updated: "" },
      imts: clone(C.imts).map((t) => ({ incident: "", dateComm: "", remarks: "", ...t })), imtsUpdated: "",
      crews: clone(C.crews), ooaCrews: [], t2iaCrews: [], crewsUpdated: "",
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
    if (out.preset !== "custom" && !C.weightPresets[out.preset]) out.preset = C.defaultPreset;
    return out;
  }
  // View-only (js/config.js viewOnly): everyone sees the published data and nothing can be typed in.
  // Adding ?edit to the address unlocks editing in that browser only; it never changes the published data.
  const EDIT = !C.viewOnly || /[?&]edit(?:=|&|$)/.test(location.search);
  // Tabs anyone can change in view-only mode (C.editableTabs). Those changes are kept in this browser only
  // ("mine"), on top of the published data: Fire Activity counts and rating until the next scheduled run,
  // the season weights until cleared. They never change the published PL.
  const EDIT_TABS = new Set(C.viewOnly && !EDIT ? C.editableTabs || [] : []);
  const MINE_KEY = `${STORE_KEY}-mine`;
  const MINE_FIRE = ["complex", "t3", "startsAvg3", "escapes", "override"];
  let mine = null;
  const mineActive = () => Boolean(mine && (mine.fire || mine.preset));
  function storeMine() { try { if (mineActive()) localStorage.setItem(MINE_KEY, JSON.stringify(mine)); else localStorage.removeItem(MINE_KEY); } catch (e) { /* storage unavailable */ } }
  function loadMine() { if (!EDIT_TABS.size) return; try { mine = JSON.parse(localStorage.getItem(MINE_KEY) || "null"); } catch (e) { mine = null; } }
  function applyMine() {
    if (!mine) return;
    if (mine.fire && mine.fireBase !== (state.meta || {}).asOf) { delete mine.fire; delete mine.fireBase; storeMine(); } // a new run came in
    if (mine.fire) for (const k of MINE_FIRE) if (k in mine.fire) state.fire[k] = mine.fire[k];
    if (mine.preset) { state.preset = mine.preset; if (mine.weights) state.weights = { ...mine.weights }; }
    if (mineActive()) state.meta.editedAt = mine.savedAt; else mine = null;
  }
  function saveMine() {
    const pub = published ? normalize(clone(published)) : defaults();
    mine = mine || {};
    const pf = pub.fire || {}, f = {};
    for (const k of MINE_FIRE) if (state.fire[k] !== undefined && state.fire[k] !== "" && state.fire[k] !== pf[k]) f[k] = state.fire[k];
    if (Object.keys(f).length) { mine.fire = f; mine.fireBase = state.meta.asOf; } else { delete mine.fire; delete mine.fireBase; }
    const customDiff = state.preset === "custom" && JSON.stringify(calc.weightsFor(state)) !== JSON.stringify(calc.weightsFor(pub));
    if (state.preset !== pub.preset || customDiff) { mine.preset = state.preset; mine.weights = state.preset === "custom" ? { ...calc.weightsFor(state) } : undefined; }
    else { delete mine.preset; delete mine.weights; }
    mine.savedAt = nowLocal();
    storeMine();
    if (mineActive()) state.meta.editedAt = mine.savedAt; else { delete state.meta.editedAt; mine = null; }
  }
  function clearMine() {
    mine = null; storeMine();
    state = published ? normalize(clone(published)) : defaults();
    renderView(); toast("Your changes cleared: showing the published PL");
  }
  function mineBar() {
    if (!mineActive()) return `<div id="mine-bar" hidden></div>`;
    const pubPl = published ? ((published.plConfirm || {}).pl || calc.compute(normalize(clone(published))).pl) : "–";
    const what = [];
    if (mine.fire) what.push(mine.fire.override ? `Fire Activity set to ${esc(mine.fire.override)}` : "Fire Activity counts changed");
    if (mine.preset) what.push(mine.preset === "custom" ? "custom weights" : esc(C.weightPresets[mine.preset].label));
    return `<div id="mine-bar" class="mine-bar no-print"><span><b>Your changes, in this browser only:</b> ${what.join("; ")} → PL${result ? result.pl : ""}. The published PL is <b>PL${pubPl}</b>.${mine.fire ? " Fire Activity changes end at the next scheduled run." : ""}</span><button class="btn" data-act="mine-clear">Clear my changes</button></div>`;
  }
  function save(auto) {
    if (!EDIT) { if (!auto && EDIT_TABS.has(view)) saveMine(); renderFooter(); return; }
    if (!auto) state.meta.editedAt = nowLocal(); // a person changed something
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); source = "local"; } catch (e) { /* storage unavailable */ }
    renderFooter();
  }
  async function loadPublished() {
    if (window.PL_SEED) return clone(window.PL_SEED);
    try {
      const r = await fetch("data/current.json", { cache: "no-store" });
      if (r.ok) return await r.json();
      const s = await fetch("data/seed.json", { cache: "no-store" }); // new repository, before the first run
      if (s.ok) return await s.json();
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
    if (newer("crewsSource")) { Object.assign(state, clone({ crews: pub.crews, ooaCrews: pub.ooaCrews || [], t2iaCrews: pub.t2iaCrews || [], crewsUpdated: pub.crewsUpdated, crewsSource: pub.crewsSource })); took.push("crews"); }
    if (((pub.fire || {}).fetchedAt || "") > ((state.fire || {}).fetchedAt || "")) { state.fire = clone(pub.fire); took.push("fire activity"); }
    if (newer("imtsSource")) { Object.assign(state, clone({ imts: pub.imts, imtsUpdated: pub.imtsUpdated, imtsSource: pub.imtsSource })); took.push("IMTs"); }
    // archive-only sections and the "as of" time always follow the newest published run
    for (const k of ["fireStarts", "raws", "femsNfdr"]) if (newer(k)) state[k] = clone(pub[k]);
    if (((pub.forecast || {}).issued || "") > ((state.forecast || {}).issued || "")) { state.forecast = clone(pub.forecast); state.forecastDanger = clone(pub.forecastDanger || {}); }
    if (((pub.actualPl || {}).checkedAt || "") > ((state.actualPl || {}).checkedAt || "")) state.actualPl = clone(pub.actualPl);
    if (pub.meta && (pub.meta.asOf || "") > (state.meta.asOf || "")) {
      state.meta.asOf = pub.meta.asOf; state.meta.source = pub.meta.source;
      if (!took.length) took.push("data");
    }
    return took;
  }
  /* ERC/BI percentile breakpoints (data/erc_bi_breakpoints.csv, edited by hand): used when an ERC/BI file is worked out here. */
  async function loadBreakpoints() {
    const N = window.PL_NFDRS;
    if (!N) return;
    try {
      const text = window.PL_BREAKPOINTS_CSV || (await (await fetch("data/erc_bi_breakpoints.csv", { cache: "no-store" })).text());
      N.setBreakpoints(N.readBreakpointsCsv(text), "data/erc_bi_breakpoints.csv");
    } catch (e) { /* keep the built-in breakpoints */ }
  }
  async function init() {
    await loadBreakpoints();
    published = await loadPublished();
    if (published && published.preset && Review && Review.setSeason) Review.setSeason(published.preset);
    let local = null;
    if (EDIT) { try { local = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { local = null; } }
    if (!EDIT) { state = published ? normalize(clone(published)) : defaults(); source = "view"; document.body.classList.add("view-only"); loadMine(); applyMine(); }
    else if (local) {
      state = normalize(local); source = "local";
      const took = mergeNewer(published);
      if (took.length) { save(true); setTimeout(() => toast(`Updated to the ${fmtDate(state.meta.asOf, true)} run`), 300); }
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
    // a page left open picks up each scheduled run (8 AM / 9 PM) without a reload
    setInterval(async () => {
      const pub = await loadPublished();
      if (!pub) return;
      published = pub;
      const took = !EDIT || (source === "published" && !(state.meta && state.meta.editedAt)) ? (state = normalize(clone(pub)), applyMine(), ["data"]) : mergeNewer(pub);
      if (took.length) { save(true); renderView(); toast(`Updated to the ${fmtDate(state.meta.asOf, true)} run`); }
    }, 30 * 60 * 1000);
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
      state.outlook = o; save(true);
      pullStatus.outlook = "";
      if (view === "outlook") renderView(); else refresh();
      toast(`7-Day outlook updated (Day 1 ${fmtDate(o.startDate)})`);
    } catch (e) {
      const took = mergeNewer(await loadPublished());
      if (took.includes("7-Day outlook")) { save(true); renderView(); }
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
      `<a class="tab" href="#${v.id}" data-view="${v.id}">${v.el ? `<i class="dot" data-el="${v.el}"></i>` : ""}${esc(v.label)}${v.id === "health" ? `<span class="hbadge" id="health-badge" hidden></span>` : ""}</a>`).join("");
  }
  /* The PL that stands: the job's confirmed PL (it only changes when two scheduled runs agree) unless someone
     has edited data in this browser, in which case the calculated PL for those edits. */
  const confirm = () => (state.plConfirm && state.plConfirm.pl && !(state.meta && state.meta.editedAt) ? state.plConfirm : null);
  const shownPl = () => (confirm() ? confirm().pl : result.pl);
  function pendingNote() {
    const c = confirm();
    if (!c || c.pl === result.pl) return "";
    const need = Math.max(1, ((C.plConfirm || {}).runsToAgree || 2) - ((c.pending || {}).runs || 0));
    return `<p class="pending-note"><b>Calculated PL${result.pl}</b> on the latest data. The PL stays <b>PL${c.pl}</b> until ${need === 1 ? "the next scheduled run agrees" : `${need} more scheduled runs agree`} (8 AM and 9 PM Mountain), so one odd update can't move it.</p>`;
  }
  function refresh() {
    result = calc.compute(state);
    const mb = $("#mine-bar"); if (mb) mb.outerHTML = mineBar();
    const plate = $("#hdr-plate");
    plate.dataset.pl = shownPl();
    $("#hdr-pl").textContent = shownPl();
    $("#hdr-score").textContent = shownPl() !== result.pl ? `${fmt3(result.score)} · calc. PL${result.pl}` : fmt3(result.score);
    const edited = state.meta.editedAt && state.meta.editedAt > (state.meta.asOf || "") ? ` · your edits ${fmtDate(state.meta.editedAt, true)}` : "";
    $("#hdr-asof").textContent = `As of ${fmtDate(state.meta.asOf, true).replace(/<[^>]+>/g, "")}${edited} · ${presetLabel()}`;
    document.title = `PL${shownPl()} · SWA Preparedness Level`;
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
    lockForViewing();
    refreshHealthBadge();
  }
  function renderView() {
    result = calc.compute(state);
    $("#main").innerHTML = mineBar() + VIEW[view]();
    refresh();
    renderFooter();
    lockForViewing();
  }
  // In view-only mode: everything that would change data is hidden or switched off. Viewing controls
  // (Season Review range and trial, History calendar and grouping, the Type 2IA comparison) stay usable.
  const VIEW_OK = /^(rv-|hist-|cal-|t2ia-|f-brief)/;
  const EDIT_ACTS = new Set(["add-crew", "add-imt", "bulk-ask", "bulk-do", "del-row", "fire-auto", "paste-7day", "paste-nfdrs", "pull-outlook", "reset-ask", "reset-do", "copy-json"]);
  function lockForViewing(root = document.getElementById("main")) {
    if (EDIT || !root) return;
    if (EDIT_TABS.has(view)) { // changeable here, in this browser only: just hide what would replace all the data
      for (const el of root.querySelectorAll('[data-act="copy-json"], [data-act="reset-ask"], label[for="import-file"], #reset-confirm')) el.hidden = true;
      return;
    }
    for (const el of root.querySelectorAll("input, select, textarea")) {
      if (VIEW_OK.test(el.id || "") || el.closest("[data-viewable]")) continue;
      el.disabled = true;
    }
    for (const b of root.querySelectorAll("[data-act]")) if (EDIT_ACTS.has(b.dataset.act)) b.hidden = true;
    for (const b of root.querySelectorAll(".sf-cell")) b.disabled = true;
    for (const el of root.querySelectorAll(".upload-panel, .edit-only, details.help.paste")) el.hidden = true;
  }
  function renderFooter() {
    const msg = {
      local: "Showing your edits, saved in this browser. Other people see their own copy until data is published to data/current.json.",
      published: "Showing published data from data/current.json. Edits you make are saved in this browser.",
      blank: "No published data found. Starting from a blank form; edits are saved in this browser.",
      view: "View-only: showing the published data from the scheduled updates (8 AM and 9 PM Mountain).",
    }[source];
    const f = $("#foot-source"); if (f) f.textContent = msg;
  }
  const repoName = () => (C.health || {}).repo || "SWCCFireWx/sw-pl-tool";
  const pubSeasonLabel = () => { const k = (published && published.preset) || C.defaultPreset; return (C.weightPresets[k] || {}).label || k; };
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
    ${(() => { const bad = healthChecks().filter((x) => x.level === "bad"); return bad.length ? `<p class="warn health-banner">${bad.length} data problem${bad.length > 1 ? "s" : ""}: ${esc(bad[0].area)}${bad.length > 1 ? " and more" : ""}. See <a href="#health">Data Health</a>.</p>` : ""; })()}
    <section class="panel" id="summary"></section>
    <section class="panel" id="pl-forecast">${forecastPanel()}</section>
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
  /* PL forecast: Day 1 (today) to Day 7, from this morning's 7-Day outlook (see calc.forecast). */
  function forecastDays() { return calc.forecast(state, { today: todayIso() }); }
  const dayName = (iso, lead) => (lead === 0 ? "Today" : lead === 1 ? "Tomorrow" : new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }));
  const shortDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  // A one-sentence summary a non-specialist can read.
  function forecastSentence(f) {
    if (!f.length) return "";
    const first = f[0].pl, last = f[f.length - 1];
    const changes = [];
    for (let i = 1; i < f.length; i++) if (f[i].pl !== f[i - 1].pl) changes.push(f[i]);
    if (!changes.length) return `The PL is expected to stay at <b>PL${first}</b> through ${shortDate(last.date)}.`;
    const why = (d, prev) => {
      const up = d.pl > prev.pl, rs = ["Minimum", "Low", "Moderate", "High", "Maximum", "Extreme"], i = (r) => rs.indexOf(r);
      const moved = [];
      if (i(d.ratings.outlook) !== i(prev.ratings.outlook)) moved.push(`fire potential ${i(d.ratings.outlook) > i(prev.ratings.outlook) ? "rises" : "eases"}`);
      if (i(d.ratings.danger) !== i(prev.ratings.danger)) moved.push(`fire danger ${i(d.ratings.danger) > i(prev.ratings.danger) ? "rises" : "eases"}`);
      if (i(d.ratings.fire) !== i(prev.ratings.fire)) moved.push(`the fire workload ${i(d.ratings.fire) > i(prev.ratings.fire) ? "grows" : "eases"}`);
      return `${up ? "rising" : "dropping"} to <b>PL${d.pl}</b> on ${shortDate(d.date)}${moved.length ? ` as ${moved.join(" and ")}` : ""}`;
    };
    const parts = changes.slice(0, 3).map((d) => why(d, f[f.indexOf(d) - 1]));
    return `The PL is expected to start at <b>PL${first}</b>, ${parts.join(", then ")}.`;
  }
  function forecastPanel() {
    const f = forecastDays();
    const a = state.actualPl;
    const fd = state.forecastDanger || {};
    const o = state.outlook || {};
    const today = todayIso();
    const plain = (r) => esc(r === "Extreme" ? "Extreme" : r);
    const card = (d) => `<div class="fc-day${d.lead === 0 ? " today" : ""}" title="PL score ${fmt3(d.score)}${d.held ? " (held at PL2: no fires on the ground)" : ""}">
        <div class="fc-date"><b>${dayName(d.date, d.lead)}</b><span>${fmtDate(d.date).replace(/, \d{4}$/, "")}</span></div>
        <div class="fc-dayno">Day ${d.outlookDay} of the 7-Day</div>
        <div class="fc-pl" data-pl="${d.pl}">PL ${d.pl}</div>
        <dl class="fc-els">
          <div><dt>Fire workload</dt><dd>${chip(d.ratings.fire)}</dd></div>
          <div><dt>Fire potential</dt><dd>${chip(d.ratings.outlook)}</dd></div>
          <div><dt>Fire danger</dt><dd>${chip(d.ratings.danger)}</dd></div>
        </dl>
        ${d.held ? `<p class="fc-note">Held at PL2: PL3 and up need fires on the ground</p>` : ""}
      </div>`;
    const issuedNote = o.startDate && o.startDate !== today
      ? `<p class="warn small">This morning's 7-Day isn't in yet, so this uses the one issued ${fmtDate(o.startDate)} (today is its Day ${f.length ? f[0].outlookDay : "?"}) and covers only the days it still reaches.</p>` : "";
    return `<div class="panel-head"><h3>PL forecast for the next 7 days</h3>${a && a.pl ? `<span class="small">Official SW PL today: <b>PL${a.pl}</b> <span class="muted">(${esc(a.source.replace(/ \(.*\)$/, ""))}${a.asOf ? `, ${fmtDate(a.asOf, true)}` : ""})</span></span>` : ""}</div>
      <p class="fc-sentence">${forecastSentence(f)}</p>
      ${issuedNote}
      <div class="fc-strip">${f.map(card).join("")}</div>
      <details class="help"><summary>How this forecast is made</summary>
        <ul class="small">
          <li><b>Day 1 is today</b>, Day 2 is tomorrow, and so on to Day 7, matching the 7-Day Fire Potential Outlook issued this morning${o.startDate ? ` (${fmtDate(o.startDate)})` : ""}.</li>
          <li><b>Fire potential</b> comes from that outlook. Like today's PL, each day looks ahead from that day to the end of the outlook: Day 1 looks at all 7 days, Day 2 at Days 2–7, and Day 7 at Day 7 only.</li>
          <li><b>Fire danger</b> is the ERC forecast from FEMS for the same 40 weather stations the PL uses${Object.keys(fd).length ? "" : " (not available right now, so the latest observed values are used for every day)"}.</li>
          <li><b>Fire workload</b> starts from today's fires, crews and incident management teams, which can't be forecast and are held steady. It goes up a step on days when the fire potential is High or rising, so it can change from day to day.</li>
          <li>This is a forecast, not the official PL. Every forecast is saved and checked against the official PL (Season Review → Forecast vs actual PL).</li>
        </ul></details>`;
  }
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
          <td class="el-name"><a href="#${viewFor[e.key]}">${esc(e.name)}</a>${e.inverted ? `<div class="muted small">${e.weight ? "Inverted scale: less available, higher PL" : "Counted inside Fire Activity (resources busy in the Southwest)"}</div>` : ""}</td>
          <td>${chip(e.rating, false, e.inverted)}</td>
          <td class="num">${fmt2(e.weight)}</td>
          <td><div class="contrib"><div class="track" title="${fmt3(e.contribution)} of ${fmt2(e.weight)}">
            <div class="cap" style="width:${e.weight * 100}%"></div><div class="fill" style="width:${e.contribution * 100}%"></div></div>
            <b>${fmt3(e.contribution)}</b></div></td>
          <td class="small muted">${fmtDate(...updated[e.key])}</td>
        </tr>`).join("")).join("");
    const held = r.held ? `<p class="warn"><b>Held at PL${r.pl}.</b> The score alone gives PL${r.scorePl}, but PL3 and above need fire on the ground and Fire Activity is Minimum.</p>` : "";
    const wWarn = Math.abs(r.weightTotal - 1) > 0.001 ? `<p class="warn">Weights add up to ${fmt2(r.weightTotal)}, not 1.00. Adjust them under Model &amp; Data.</p>` : "";
    return `
      <div class="panel-head"><h3>PL${shownPl()} &nbsp;·&nbsp; score ${fmt3(r.score)}${shownPl() !== r.pl ? ` <span class="muted small">(calculated PL${r.pl})</span>` : ""}</h3><span class="tag">${esc(presetLabel())}</span></div>
      ${pendingNote()}
      <div class="scale"><div class="scale-bar">${seg}<div class="scale-marker" style="left:${pos}%"><span style="${pos < 4 ? "left:0;transform:none" : pos > 96 ? "left:auto;right:0;transform:none" : ""}">${fmt3(r.score)}</span></div></div>
        <div class="scale-ticks">${ticks}</div></div>
      ${held}${wWarn}
      <div class="table-wrap"><table>
        <thead><tr><th>Element</th><th>Adjective rating</th><th class="num">Max contribution</th><th>Actual contribution</th><th>Data date</th></tr></thead>
        <tbody>${rows}
          <tr class="total-row"><td>PL score</td><td>PL${r.pl}${r.held ? " (held)" : ""}</td><td class="num">${fmt2(r.weightTotal)}</td><td><b>${fmt3(r.score)}</b></td><td></td></tr>
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
        <div class="pl-plate rep-plate" data-pl="${shownPl()}"><span class="pl-big"><span class="pl-label">PL</span><span class="pl-num">${shownPl()}</span></span><span class="pl-score">Score <b>${fmt3(r.score)}</b></span></div>
      </header>
      <section class="rep-sec">${SUMMARY.outcome()}</section>
      <section class="rep-sec rep-facts">
        <div><h3>Fire Activity ${chip(f.rating)}</h3><p class="small">Demand ${esc(f.demand)}: ${f.complex} complex (T2+), ${f.t3} T3; ${f.startsAvg ?? "–"} new starts/day; ${f.escapes ?? 0} escapes.${f.steps.map((x) => ` +1: ${esc(x.why)}.`).join("")}${f.mode === "override" ? ` Set by hand (calculated ${esc(f.computed)}).` : ""}</p></div>
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
      <p class="muted small rep-foot">PL3+ needs fire on the ground (Fire Activity above Minimum) · PL1 &lt; 0.151 ≤ PL2 &lt; 0.386 ≤ PL3 &lt; 0.62 ≤ PL4 &lt; 0.851 ≤ PL5 · Generated ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</p>
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
    const subject = `SWA Preparedness Level PL${shownPl()} – ${fmtDate(state.meta.asOf, true)}`;
    const body = `${briefText()}\n\n(Briefing PDF / Excel attached.)`;
    location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  /* ---------- Fire Activity ---------- */
  const M = C.fireActivityModel;
  const bandText = (bands) => bands.map((x) => `${x.rating} ${x.atLeast}+`).join(" · ");
  VIEW.fire = () => `
    ${head("Fire Activity", "How many resources the Southwest needs right now and how hard they are working: large fires, initial-attack load and escapes set the demand, then it steps up when IMTs or crews are stretched thin or the 7-Day outlook is rising. Everything is pulled automatically; you can correct the counts or pick a different rating.", `<div class="row">${updatedField("fire.updated", state.fire.updated)}</div>`)}
    <section class="panel" id="summary"></section>
    <section class="panel">
      <h3>Inputs</h3>
      <div class="row">
        <label class="field"><span>Complex incidents (T2 or higher)</span><input type="number" min="0" id="f-complex" data-path="fire.complex" data-num value="${esc(state.fire.complex)}"></label>
        <label class="field"><span>T3 incidents</span><input type="number" min="0" id="f-t3" data-path="fire.t3" data-num value="${esc(state.fire.t3)}"></label>
        <label class="field"><span>New starts per day (3-day avg)</span><input type="number" min="0" step="0.1" id="f-starts" data-path="fire.startsAvg3" data-num value="${esc(state.fire.startsAvg3 ?? "")}" placeholder="auto"></label>
        <label class="field"><span>Escapes (last 3 days)</span><input type="number" min="0" id="f-escapes" data-path="fire.escapes" data-num value="${esc(state.fire.escapes ?? "")}" placeholder="0"></label>
      </div>
      <p class="muted small">Large fires: ${C.fireActivity.filter((f) => Number.isFinite(f.maxIncidents)).map((f) => `${f.rating} ≤${f.maxIncidents} (≤${f.maxComplex} complex)`).join(" · ")} · Maximum above that.
        Starts/day: ${bandText(M.startsPerDay)}. Escapes: ${bandText(M.escapes)} (found in the last 3 days, still uncontained, 100+ acres or T3+).
        +1 step when resources are busy in the Southwest: ${M.capacity.minCimtCommittedInSw}+ CIMTs or ${M.capacity.minT3CommittedInSw}+ Type 3 teams on Southwest incidents, or ${Math.round(M.capacity.minCrewShareCommittedInSw * 100)}%+ of the crews in the Southwest committed there (crews out of area are left out of the count; teams and crews out of area, off rotation or unavailable never add the step); +1 step when the 7-Day is High/Maximum or rising. No steps without fire on the ground. Thresholds are in <code>js/config.js</code>.</p>
      <div id="fire-incidents"></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h3>Fire Activity rating</h3>${state.fire.override ? `<button class="btn" data-act="fire-auto">Go back to the calculated rating</button>` : ""}</div>
      <p class="muted small">The calculated rating is selected. Picking another one overrides it in this browser until the next scheduled run.</p>
      <div class="rating-cards">${C.fireActivity.map((f) => `
        <label class="rating-card" data-r="${f.rating}">
          <input type="radio" name="fire-rating" id="f-fire-${f.rating}" data-path="fire.override" data-rerender value="${f.rating}" ${result.fire.rating === f.rating ? "checked" : ""}>
          <span class="t">${f.rating}<span class="tag" data-suggest="${f.rating}" hidden>Calculated</span></span>
          <p>${esc(f.text)}</p>
        </label>`).join("")}</div>
    </section>`;
  SUMMARY.fire = () => {
    const f = result.fire;
    const step = (label, r, note) => `<div class="fa-step"><span class="fa-label">${label}</span>${chip(r)}${note ? `<span class="muted small">${note}</span>` : ""}</div>`;
    const startsNote = f.startsAvg === null || f.startsAvg === undefined ? "no fire-start data" : `${f.startsAvg} new starts/day`;
    const chain = [
      step("Large fires", f.large, `${f.complex} complex/T2+, ${f.t3} T3`),
      step("Initial attack", f.ia, `${startsNote}; ${f.escapes ?? 0} escape${f.escapes === 1 ? "" : "s"}`),
      `<div class="fa-step fa-demand"><span class="fa-label">Demand (higher of the two)</span>${chip(f.demand)}</div>`,
      ...(f.demand === "Minimum" ? [`<div class="fa-step"><span class="muted small">No fire on the ground, so IMT/crew capacity and the 7-Day don't add steps.</span></div>`]
        : f.steps.length ? f.steps.map((x) => `<div class="fa-step"><span class="fa-label">+1 step</span><span class="small">${esc(x.why)}</span></div>`)
        : [`<div class="fa-step"><span class="muted small">IMTs and crews not busy in the Southwest; 7-Day not rising. No steps added.</span></div>`]),
      `<div class="fa-step fa-total"><span class="fa-label">Calculated Fire Activity</span>${chip(f.computed)}</div>`,
    ].join("");
    const ov = f.mode === "override" ? `<p class="warn">Overridden by hand: <b>${esc(f.rating)}</b> is used instead of the calculated ${esc(f.computed)}.</p>` : "";
    const src = state.fire.source ? `<p class="small"><span class="tag">${esc(state.fire.source)}</span>${state.fire.fetchedAt ? ` <span class="muted">pulled ${fmtDate(state.fire.fetchedAt, true)}</span>` : ""}</p>` : "";
    return `<div class="panel-head"><h3>How the rating is built</h3>${chip(f.rating)}</div><div class="fa-chain">${chain}</div>${ov}${src}`;
  };
  function fireIncidents() {
    const fs1 = state.fireStarts, y = fs1 && fs1.daily && fs1.daily[fs1.to];
    const incs = (state.fire.incidents || []);
    const esc1 = state.fire.escapeList && state.fire.escapeList.length ? `<p class="small">Escapes: ${state.fire.escapeList.map(esc).join(", ")}</p>` : "";
    const incTable = incs.length ? `<div class="table-wrap"><table><thead><tr><th>Incident</th><th>Type</th><th>PSA</th><th class="num">Acres</th><th class="num">% contained</th><th>Discovered</th></tr></thead><tbody>${incs.map((i) => `<tr><td>${esc(i.name)}</td><td>${i.type <= 2 ? `<b>T${i.type}</b>` : `T${i.type}`}</td><td class="psa-id">${esc(i.psa)}</td><td class="num">${esc(i.acres)}</td><td class="num">${esc(i.contained)}</td><td>${fmtDate(i.discovered)}</td></tr>`).join("")}</tbody></table></div>` : (state.fire.fetchedAt ? `<p class="muted small">No active T3 or higher incidents in the SW PSAs${state.fire.activeTotal ? ` (${state.fire.activeTotal} smaller active incidents)` : ""}.</p>` : "");
    return incTable + esc1 + (y ? `<p class="small">New starts ${fmtDate(fs1.to)} (WFIGS): <b>${y.total}</b> · lightning ${y.lightning} · human ${y.human} · unknown ${y.unknown} · ${y.acres} acres. <a href="#history">History</a></p>` : "");
  }
  AFTER.fire = [() => {
    for (const t of document.querySelectorAll("[data-suggest]")) t.hidden = t.dataset.suggest !== result.fire.computed;
    for (const r of document.querySelectorAll('[name="fire-rating"]')) r.checked = r.value === result.fire.rating;
    const box = $("#fire-incidents"); if (box) box.innerHTML = fireIncidents();
  }];

  /* ---------- IMTs ---------- */
  VIEW.imt = () => `
    ${head("IMT Availability", "Team status comes from the SWCC SharePoint workbook and can be changed here. Availability uses an inverted scale: fewer available teams raises the PL.", `<div class="row">${updatedField("imtsUpdated", state.imtsUpdated)}</div>`)}
    ${sourceBar("imts")}
    <section class="panel" id="summary"></section>
    <section class="panel">
      <div class="panel-head"><h3>Team status</h3><button class="btn" data-act="add-imt">Add team</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Mob</th><th>Type</th><th>No. / Zone</th><th>Incident Commander</th><th>Home dispatch</th><th>Status</th><th>Incident</th><th title="Where a committed team is working: in the Southwest (counts toward resources busy) or out of area (doesn't)">Assigned in</th><th>Date comm.</th><th>Remarks</th><th></th></tr></thead>
        <tbody>${state.imts.map((t, i) => `<tr>
          <td><input type="text" class="w-s" id="imt-${i}-mob" data-list="imts" data-idx="${i}" data-field="mob" value="${esc(t.mob)}"></td>
          <td><select id="imt-${i}-type" data-list="imts" data-idx="${i}" data-field="type">${C.imtTypes.map((o) => `<option ${String(t.type) === o ? "selected" : ""}>${o}</option>`).join("")}</select></td>
          <td><input type="text" class="w-s" id="imt-${i}-zone" data-list="imts" data-idx="${i}" data-field="zone" value="${esc(t.zone)}"></td>
          <td><input type="text" class="w-m" id="imt-${i}-ic" data-list="imts" data-idx="${i}" data-field="ic" value="${esc(t.ic)}"></td>
          <td><input type="text" class="w-s" id="imt-${i}-home" data-list="imts" data-idx="${i}" data-field="home" value="${esc(t.home)}"></td>
          <td>${statusSelect(`imt-${i}-status`, "imts", i, t.status, C.imtStatuses)}</td>
          <td><input type="text" class="w-m" id="imt-${i}-inc" data-list="imts" data-idx="${i}" data-field="incident" value="${esc(t.incident)}"></td>
          <td class="small">${statusGroup(C.imtStatuses, t.status) === "committed" ? (() => { const w = calc.inSouthwest(t); const where = [t.incState, t.incDisp].filter(Boolean).join(" · "); return `${esc(where || "not given")}<br>${w.sw ? `<span class="tag">Southwest${w.known ? "" : " (assumed)"}</span>` : `<span class="tag muted">out of area · not counted</span>`}`; })() : ""}</td>
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
        <td><select id="${list}-${i}-type" data-list="${list}" data-idx="${i}" data-field="type">${[...new Set([...C.crewTypes, c.type].filter(Boolean))].map((o) => `<option ${c.type === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></td>
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
    </section>
    <section class="panel">
      <div class="panel-head"><h3>SWA Type 2IA crews</h3><button class="btn" data-act="add-crew" data-list="t2iaCrews">Add crew</button></div>
      <p class="muted small">From the "SWA Type 2IA" tab of the same SharePoint workbook${state.crewsSource && state.crewsSource.t2iaLastUpdate ? ` (sheet last update ${esc(state.crewsSource.t2iaLastUpdate)})` : ""}. Use the switch above to count them in crew availability or not.</p>
      ${(state.t2iaCrews || []).length ? crewTable("t2iaCrews") : `<p class="muted">No Type 2IA crews pulled yet; they come in with the next scheduled update.</p>`}
    </section>`;
  SUMMARY.crews = () => {
    const c = result.crews;
    const on = c.includeT2IA, other = calc.compute(state, { includeT2IA: !on });
    const official = Boolean(C.crewAvailability.includeT2IA);
    const t2 = `<div class="t2ia-box">
        <label class="switch"><input type="checkbox" id="t2ia-toggle" ${on ? "checked" : ""}> <span>Count SWA Type 2IA crews in crew availability</span></label>
        <p class="small">${c.t2iaTotal} Type 2IA crews, ${c.t2iaAvail} available. ${on ? "Counted" : "Not counted"}: ${pct(c.ratio)} available → ${chip(c.rating, false, true)}, PL${result.pl} (${fmt3(result.score)}).
          ${on ? "Not counted" : "Counted"}: ${pct(other.crews.ratio)} → ${chip(other.crews.rating, false, true)}, PL${other.pl} (${fmt3(other.score)}).
          ${other.pl === result.pl && other.crews.rating === result.crews.rating ? "No difference today." : ""}</p>
        <p class="muted small">The published PL ${official ? "counts" : "doesn't count"} them (<code>crewAvailability.includeT2IA</code> in js/config.js). ${on !== official ? "<b>You're looking at the other way</b>; this switch only changes what this browser shows." : "This switch only changes what this browser shows."} Every run archives both (history.csv: <code>pl_with_t2ia</code>, <code>pl_without_t2ia</code>), and Season Review can compare them over a season.</p>
      </div>`;
    const counts = C.crewStatuses.filter((s) => c.swa.byStatus[s.code] || c.ooa.byStatus[s.code])
      .map((s) => `<span class="tag" title="${esc(s.label)}">${s.code}: ${c.swa.byStatus[s.code]}${c.ooaTotal ? ` + ${c.ooa.byStatus[s.code]} OOA` : ""}</span>`).join(" ");
    return `<div class="panel-head"><h3>Total Crew Availability metric</h3>${chip(c.rating, true, true)}</div>${t2}
      <div class="stats">
        <div class="stat"><span class="k">SWA crews</span><span class="v">${c.swaTotal}</span></div>
        <div class="stat"><span class="k">SWA available</span><span class="v">${c.swa.available} <small>+ ${c.swa.prepoSWCC} prepo SWCC</small></span></div>
        <div class="stat"><span class="k">OOA counted</span><span class="v">${c.ooaAvail} <small>of ${c.ooaTotal}</small></span></div>
        <div class="stat"><span class="k">Committed in SWA</span><span class="v">${c.swa.committed} <small>${pct(c.commitRatio)}</small></span></div>
        <div class="stat"><span class="k">Out of area</span><span class="v">${c.committedOut} <small>not counted</small></span></div>
        <div class="stat"><span class="k">Crews in the Southwest</span><span class="v">${c.pool} <small>of ${c.total}</small></span></div>
        <div class="stat"><span class="k">Available ÷ crews in the SW</span><span class="v">${pct(c.ratio)} <small>${c.totalAvail}/${c.pool}</small></span></div>
        <div class="stat"><span class="k">Committed in the SW</span><span class="v">${pct(c.committedSwShare)} <small>${c.committedSw}/${c.pool}</small></span></div>
      </div>
      <div class="metric" data-r="${sev(c.rating, true)}"><span class="label">Total availability ${chip(c.rating, false, true)}</span>
        <span class="muted small">SWA only: ${chip(c.swaRating, false, true)}</span>
        <span class="why">Available = A, AG, AD, plus P at SWCC${C.crewAvailability.includeOOAAvailable ? ", for SWA and OOA crews" : "; OOA crews count only when prepositioned at SWCC"}, divided by the crews in the Southwest (SWA crews minus those committed out of area, C-O). Ratio ≥ 100% → Maximum · &gt;60% High · &gt;39% Moderate · &gt;11% Low · otherwise Minimum.</span></div>
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
    ${head("PSA ERCy Values (observed fire danger)", "ERCy and BIy value and percentile for each PSA, worked out automatically every update from yesterday's FEMS daily summary for the 40 SWCC stations, exactly as the NFDRSy processing workbook does. You can still upload a file, paste rows or type values in. The PL uses the ERCy percentiles; BIy is recorded for reference.",
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
          <p class="muted small">Accepts the FEMS daily-summary CSV (the NFDRSy workbook's data-pull link) or the NFDRSy workbook itself, which are worked out station by station like the workbook; or a file with a PSA column (SW01 … SW14N) and ERC/BI columns such as <em>PSA Avg, ERCy Avg, BI Avg, ERCy Percentile, BI Percentile, ObsDate</em>.</p>
          <p class="muted small"><a href="${esc(window.PL_NFDRS ? window.PL_NFDRS.downloadUrl(Review.addDays(todayIso(), -1)) : "#")}" target="_blank" rel="noopener">Yesterday's FEMS daily summary for the 40 stations</a> (CSV).</p>
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
    </div>
    ${ercStations()}`;
  function ercStations() {
    const st = state.danger.stations;
    if (!st || !st.length) return "";
    const N = window.PL_NFDRS;
    const byPsa = {};
    for (const x of st) (byPsa[x.psa] = byPsa[x.psa] || []).push(x);
    const rows = Object.entries(byPsa).map(([psa, list]) => {
      const r = state.danger.rows[psa] || {}, bp = N && N.BREAKPOINTS[psa];
      return list.map((x, i) => `<tr${i === 0 ? ' class="grp"' : ""}>${i === 0 ? `<td class="psa-id" rowspan="${list.length}">${psa}</td>` : ""}<td>${esc(x.name)} <span class="muted small">${x.id}</span></td>
        <td class="num">${x.reported ? x.erc : `<span class="warn-t">not reported</span>`}</td><td class="num">${x.reported ? dash1(x.bi) : ""}</td>
        ${i === 0 ? `<td class="num" rowspan="${list.length}"><b>${showVal(r.ercVal)}</b> → ${showVal(r.ercPct)}th</td><td class="num" rowspan="${list.length}">${showVal(r.biVal)} → ${showVal(r.biPct)}th</td>
        <td class="small muted" rowspan="${list.length}">${bp ? `${bp.erc.p50} / ${bp.erc.p75} / ${bp.erc.p85} / ${bp.erc.p90} / ${bp.erc.p97}` : ""}</td>` : ""}</tr>`).join("");
    }).join("");
    return `<section class="panel"><div class="panel-head"><h3>Stations behind the PSA values · ${fmtDate(state.danger.date)}</h3><span class="muted small">${esc(state.danger.source || "")}</span></div>
      <div class="table-wrap"><table class="erc-stations"><thead><tr><th>PSA</th><th>Station</th><th class="num">ERC (daily max)</th><th class="num">BI (daily max)</th><th class="num">PSA ERCy → percentile</th><th class="num">PSA BI → percentile</th><th>ERC breakpoints 50 / 75 / 85 / 90 / 97th</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">ERCy = the stations' ERC added up, rounded up to a whole number, then divided by the number of stations that reported; BI = the plain average. A station that didn't report is left out of its PSA's average. Percentiles: ERCy 97 / 90 / 85 / 75 / 50, otherwise 45; BI 97 / 90 / 75 / 50, otherwise 45, at the breakpoints below.</p></section>
      ${breakpointTable()}`;
  }
  function breakpointTable() {
    const N = window.PL_NFDRS; if (!N) return "";
    const B = N.BREAKPOINTS, ks = ["p10", "p20", "p30", "p40", "p50", "p60", "p70", "p75", "p80", "p85", "p90", "p95", "p97"];
    const used = { erc: ["p50", "p75", "p85", "p90", "p97"], bi: ["p50", "p75", "p90", "p97"] };
    const tbl = (idx, label) => `<h4>${label}</h4><div class="table-wrap"><table class="bp-table"><thead><tr><th>PSA</th>${ks.map((k) => `<th class="num${used[idx].includes(k) ? " used" : ""}">${k.slice(1)}th</th>`).join("")}</tr></thead><tbody>
      ${Object.keys(N.STATIONS).map((psa) => `<tr><td class="psa-id">${psa}</td>${ks.map((k) => { const v = ((B[psa] || {})[idx] || {})[k]; return `<td class="num${used[idx].includes(k) ? " used" : ""}">${Number.isFinite(v) ? v : "–"}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`;
    return `<section class="panel"><div class="panel-head"><h3>ERC and BI breakpoints</h3><span class="muted small">${esc(N.BREAKPOINTS_SOURCE)}${state.danger.breakpoints && state.danger.breakpoints !== N.BREAKPOINTS_SOURCE ? ` · the PSA values above were worked out with ${esc(state.danger.breakpoints)}` : ""}</span></div>
      <p class="small">These are recalculated by hand. To change them for everyone: edit <code>data/erc_bi_breakpoints.csv</code> in the repository (it opens in Excel, or edit it on GitHub with the pencil icon), or upload the NFDRSy processing workbook with its updated <em>ERC BREAK POINTS</em> and <em>BI BREAK POINTS</em> tabs to the <b>uploads</b> folder. Either one recalculates the PSA percentiles within a few minutes. The highlighted columns are the ones the percentiles use.</p>
      ${tbl("erc", "ERC (ERCs 8/25)")}${tbl("bi", "BI (BI -8/25)")}</section>`;
  }
  const dash1 = (v) => (v === null || v === undefined || v === "" ? "–" : v);
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
    state.danger = { date: res.date || todayIso(), rows, source: label, fetchedAt: nowLocal(), ...(res.stations ? { stations: res.stations } : {}) };
    const got = Object.keys(res.rows).length;
    const avg = Object.values(res.rows).some((r) => r.rowsUsed > 1);
    const noPct = !res.columns.includes("ercPct");
    const bpNote = res.breakpoints ? `<p class="import-ok small">Breakpoints taken from the workbook's ERC/BI BREAK POINTS tabs (this browser only; to change them for everyone, upload the workbook to the repository's <b>uploads</b> folder or edit <code>data/erc_bi_breakpoints.csv</code>).</p>${res.bpWarnings && res.bpWarnings.length ? `<p class="warn small">Check: ${esc(res.bpWarnings.join("; "))}</p>` : ""}` : "";
    if (res.breakpointsOnly) { lastImport = bpNote; renderView(); toast("Breakpoints loaded"); return; }
    lastImport = bpNote + (res.fromStations ? `<p class="import-ok small">Worked out ${got} of ${C.psas.length} PSAs from ${res.rowsRead} FEMS stations${res.date ? ` for ${fmtDate(res.date)}` : ""}${res.sheet ? ` (sheet “${esc(res.sheet)}”)` : ""}, the same way as the NFDRSy processing workbook.</p>` + (res.missing.length ? `<p class="warn small">No stations reported for ${esc(res.missing.join(", "))}.</p>` : "") : `<p class="import-ok small">Loaded ${got} of ${C.psas.length} PSAs from ${res.rowsRead} row${res.rowsRead > 1 ? "s" : ""}${res.sheet ? ` on sheet “${esc(res.sheet)}”` : ""}${res.date ? `, dated ${fmtDate(res.date)}` : ""}${avg ? "; several rows per PSA were averaged" : ""}.</p>`
      + (res.missing.length ? `<p class="warn small">No values for ${esc(res.missing.join(", "))}.</p>` : "")
      + (noPct ? `<p class="warn small">The file has no ERCy percentile column, so the Fire Danger Metric can't be rated until percentiles are entered.</p>` : ""));
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
  const archive = { loaded: false, history: [], daily: [], raws: [], outlookPsa: [], ercyPsa: [], imported: [], error: "", groupBy: "pl", allRuns: false };
  async function loadArchive() {
    if (archive.loaded) return;
    archive.loaded = true;
    if (window.PL_ARCHIVE) { Object.assign(archive, window.PL_ARCHIVE); return; }
    const get = async (f) => {
      try { const r = await fetch(`data/archive/${f}`, { cache: "no-store" }); if (!r.ok) return []; return csvObjects(await r.text()); }
      catch (e) { return []; }
    };
    [archive.history, archive.daily, archive.raws, archive.outlookPsa, archive.ercyPsa, archive.imported, archive.forecasts, archive.actual] = await Promise.all(
      [get("history.csv"), get("fire_starts_daily.csv"), get("raws_daily.csv"), get("outlook_psa_daily.csv"), get("ercy_psa_daily.csv"), get("published_pl.csv"),
        get("forecast_pl.csv"), get("actual_pl.csv")]);
  }
  archive.getFile = async (f) => {
    try { const r = await fetch(`data/archive/${f}`, { cache: "no-store" }); if (!r.ok) return []; return csvObjects(await r.text()); }
    catch (e) { return []; }
  };
  /* The bigger station-level files, loaded only when the calendar is used. */
  async function loadDetail() {
    if (archive.detail) return archive.detail;
    const W = window.PL_ARCHIVE || {};
    const pick = async (k, f) => W[k] || archive.getFile(f);
    const [stations, checks, ercSt, fires, crews, imts] = await Promise.all([pick("rawsStations", "raws_stations_daily.csv"), pick("rawsChecks", "raws_checks.csv"),
      pick("ercyStations", "ercy_stations_daily.csv"), pick("fires", "fire_starts.csv"), pick("crewsDaily", "crews_daily.csv"), pick("imtsDaily", "imts_daily.csv")]);
    return (archive.detail = { stations, checks, ercSt, fires, crews, imts });
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

  /* ---------- calendar: everything archived for one day ---------- */
  const cal = { date: "" };
  async function showDay(date) {
    const box = $("#cal-out"); if (!box) return;
    box.innerHTML = `<p class="muted small">Loading ${fmtDate(date)}…</p>`;
    await loadArchive();
    const D = await loadDetail();
    await loadHealthExtras();
    if (cal.date !== date || !$("#cal-out")) return;
    $("#cal-out").innerHTML = dayHtml(date, D);
  }
  function dayData(date, D) {
    const on = (rows, k = "date") => (rows || []).filter((r) => String(r[k] || "").slice(0, 10) === date);
    return { runs: (archive.history || []).filter((h) => h.run_date === date), published: on(archive.imported)[0], actual: on(archive.actual)[0],
      forecasts: (archive.forecasts || []).filter((f) => f.target_date === date).sort((a, b) => a.issued.localeCompare(b.issued)),
      starts: on(archive.daily)[0], fires: on(D.fires), raws: on(archive.raws), stations: on(D.stations), checks: on(D.checks),
      ercy: on(archive.ercyPsa), ercSt: on(D.ercSt), crews: (() => { const r = on(D.crews); const last = r.map((x) => x.run_time).sort().pop(); return r.filter((x) => x.run_time === last); })(),
      imts: (() => { const r = on(D.imts); const last = r.map((x) => x.run_time).sort().pop(); return r.filter((x) => x.run_time === last); })() };
  }
  function dayHtml(date, D) {
    const x = dayData(date, D);
    const t = (head, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th${/^(?:#|n|num)/.test(h[1] || "") ? ' class="num"' : ""}>${esc(h[0])}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((h, i) => `<td${/^(?:#|n|num)/.test(h[1] || "") ? ' class="num"' : ""}>${r[i] ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : `<p class="muted small">Nothing archived.</p>`;
    const N = (h) => [h, "num"];
    const pls = [...x.runs.map((h) => `PL${h.pl} <span class="muted small">(this tool, ${esc(h.run_time.slice(11, 16))} run)</span>`),
      x.published ? `PL${x.published.pl} <span class="muted small">(published)</span>` : "", x.actual ? `PL${x.actual.pl} <span class="muted small">(${esc(x.actual.source)})</span>` : ""].filter(Boolean);
    const fc = x.forecasts.filter((f) => +f.lead_days > 0).map((f) => `${esc(f.issued.slice(5, 16).replace("T", " "))}: PL${f.pl} <span class="muted small">(${f.lead_days}-day lead)</span>`);
    const st = x.starts;
    const byPsa = (rows, f) => C.psas.map((p) => rows.find((r) => r.psa === p.ercId)).filter(Boolean).map(f);
    return `<div class="day-head"><h4>${fmtDate(date)}</h4>
        <p>${pls.length ? pls.join(" · ") : `<span class="muted">No PL archived for this day.</span>`}${fc.length ? `<br><span class="small">Forecast for this day: ${fc.join(" · ")}</span>` : ""}
        ${(() => { const r = (health.reasons || []).find((x) => String(x.date).slice(0, 10) === date); const c = (health.compare || []).find((x) => x.date === date && x.differs === "yes");
          return r && r.reason ? `<br><span class="small">Why the official PL was PL${esc(r.official_pl)} (tool PL${esc(r.tool_pl)}): ${esc(r.reason)}${r.entered_by ? ` (${esc(r.entered_by)})` : ""}</span>` : c ? `<br><span class="small warn-t">Official PL${c.official_pl} differed from the tool's PL${c.tool_pl}; no reason recorded (see Data Health).</span>` : ""; })()}</p>
        <p>${st ? `New starts: <b>${st.total}</b> (lightning ${st.lightning}, human ${st.human}, unknown ${st.unknown}) · ${Math.round(+st.acres || 0).toLocaleString()} acres` : `<span class="muted">No fire-start data for this day.</span>`}</p></div>
      <h4>Weather by PSA (RAWS + ASOS/AWOS)</h4>
      ${t([["PSA"], N("Stations"), N("Avg max temp °F"), N("Avg min RH %"), N("Lowest RH %"), N("Max gust mph"), N("Avg precip in"), N("Wetting rain stns"), ["Wind event"], N("Readings removed")],
        byPsa(x.raws, (r) => [`<b>${r.psa}</b>`, r.raws_stations !== undefined && r.raws_stations !== "" ? `${r.raws_stations} + ${r.asos_stations || 0}` : r.stations, r.avg_max_temp_f, r.avg_min_rh, r.lowest_rh, r.max_gust_mph, r.avg_precip_in, r.wetting_rain_stations, r.wind_event, r.readings_removed]))}
      <h4>ERC / BI by PSA</h4>
      ${t([["PSA"], N("ERCy"), N("ERCy percentile"), N("BI"), N("BI percentile"), N("Stations"), ["Not reported"], ["Source"]],
        byPsa(x.ercy, (r) => [`<b>${r.psa}</b>`, r.erc_val, r.erc_pct, r.bi_val, r.bi_pct, r.stations, esc(r.not_reported || ""), `<span class="muted small">${esc(r.source)}</span>`]))}
      <details class="day-more"><summary>Weather by station (${x.stations.length})</summary>
        ${t([["PSA"], ["Network"], ["Station"], N("Hours"), N("Max temp °F"), N("Min RH %"), N("Max gust mph"), N("Precip in"), N("Checks")], x.stations.map((r) => [r.psa, r.network, esc(r.station), r.hours, r.max_temp_f, r.min_rh, r.max_gust_mph, r.precip_in, r.checks]))}</details>
      <details class="day-more"><summary>Weather checks (${x.checks.length}: readings removed, kept as wind events, or flagged)</summary>
        ${t([["PSA"], ["Station"], ["What"], ["Hour"], N("Value"), ["Why"], ["Action"]], x.checks.map((r) => [r.psa, esc(r.station), esc(r.field), r.hour, r.value, esc(r.reason), esc(r.action)]))}</details>
      <details class="day-more"><summary>ERC / BI by station (${x.ercSt.length})</summary>
        ${t([["PSA"], ["Station"], N("ERC"), N("BI"), ["Reported"]], x.ercSt.map((r) => [r.psa, `${esc(r.station)} <span class="muted small">${r.station_id}</span>`, r.erc, r.bi, r.reported]))}</details>
      <details class="day-more"><summary>New fires (${x.fires.length})</summary>
        ${t([["Fire"], ["Cause"], N("Acres"), ["PSA"], ["Dispatch"]], x.fires.map((r) => [esc(r.name), esc(r.cause), r.acres, r.psa, esc(r.dispatch || "")]))}</details>
      <details class="day-more"><summary>Crews (${x.crews.length}) and IMTs (${x.imts.length})</summary>
        ${t([["List"], ["Crew"], ["Status"], ["Location"], ["Incident"]], x.crews.map((r) => [esc(r.list), esc(r.crew), esc(r.status), esc(r.location), esc(r.incident)]))}
        ${t([["Team"], ["Type"], ["IC"], ["Status"], ["Incident"]], x.imts.map((r) => [esc(r.team), esc(r.type), esc(r.incident_commander), esc(r.status), esc(r.incident)]))}</details>`;
  }
  async function downloadDay(date) {
    const D = await loadDetail();
    const x = dayData(date, D);
    const sheet = (name, rows) => { const cols = rows.length ? Object.keys(rows[0]) : ["(nothing archived)"]; return { name, cols: cols.map(() => 14), rows: [cols.map((c) => ({ v: c, s: "head" })), ...rows.map((r) => cols.map((c) => { const v = r[c]; const n = parseFloat(v); return v !== "" && String(n) === String(v).trim() ? n : v; }))] }; };
    const sheets = [sheet("PL", [...x.runs.map((h) => ({ what: `this tool (${h.run_time})`, pl: h.pl, score: h.score })), ...(x.published ? [{ what: "published", pl: x.published.pl, score: "" }] : []),
      ...(x.actual ? [{ what: `actual (${x.actual.source})`, pl: x.actual.pl, score: "" }] : []), ...x.forecasts.map((f) => ({ what: `forecast issued ${f.issued}, lead ${f.lead_days}`, pl: f.pl, score: f.score }))]),
      sheet("Weather by PSA", x.raws), sheet("Weather by station", x.stations), sheet("Weather checks", x.checks), sheet("ERC BI by PSA", x.ercy), sheet("ERC BI by station", x.ercSt),
      sheet("Fire starts", x.starts ? [x.starts] : []), sheet("New fires", x.fires), sheet("Crews", x.crews), sheet("IMTs", x.imts)];
    downloadBytes(window.PL_XLSX(sheets), `SWA_PL_day_${date}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  VIEW.history = () => `
    ${head("History &amp; Data", "Every scheduled run is archived. Each day's new fire starts (WFIGS) and RAWS weather are kept alongside that day's PL, building a record to check whether the PL calculation tracks real fire activity.")}
    <section class="panel" id="cal-panel">
      <div class="panel-head"><h3>Look up a day</h3>
        <div class="btn-row"><label class="field"><span>Date</span><input type="date" id="cal-date" value="${esc(cal.date)}" max="${esc(Review.addDays(todayIso(), -1))}"></label>
          <button class="btn" data-act="cal-dl" ${cal.date ? "" : "disabled"}>Download this day (Excel)</button></div></div>
      <div id="cal-out"><p class="muted small">Pick a date to see that day's weather by PSA and station (RAWS and ASOS/AWOS, after the quality checks), ERC/BI by PSA and station, new fire starts, the PL, the forecasts made for it, and crews and IMTs.</p></div>
    </section>
    <div class="grid-2">
      <section class="panel">${yesterdayStarts()}</section>
      <section class="panel">${yesterdayRaws()}</section>
    </div>
    <section class="panel" id="summary"><p class="muted">Loading the archive…</p></section>`;
  AFTER.history = [async () => {
    if (cal.date) showDay(cal.date);
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
    if (!w.byPsa && !nf.byPsa) return `<h3>Weather</h3><p class="muted">Weather summaries appear after the first scheduled run (every RAWS from FEMS and every ASOS/AWOS from the Iowa Environmental Mesonet in each PSA).</p>`;
    const stn = (x) => x.asosStations !== undefined ? `<span title="RAWS + ASOS/AWOS reporting">${x.rawsStations ?? 0} + ${x.asosStations}</span>` : x.stationsListed ? `${x.stations}/${x.stationsListed}` : x.stations ?? "";
    const rows = C.psas.map((p) => { const x = (w.byPsa || {})[p.ercId] || {}, n = (nf.byPsa || {})[p.ercId] || {};
      return `<tr><td class="psa-id">${p.id}</td><td class="num">${stn(x)}</td><td class="num">${x.avgMaxTemp ?? ""}</td><td class="num">${x.avgMinRh ?? ""}</td><td class="num">${x.lowestRh ?? ""}</td><td class="num">${x.maxGust ?? ""}</td><td class="num">${x.avgPrecip ?? ""}</td><td class="num">${x.wettingRain ?? ""}</td><td>${x.windEvent ? `<span class="chip" data-r="High">${x.windyStations} stns 40+</span>` : ""}</td><td class="num">${n.erc ?? ""}</td><td class="num">${n.bi ?? ""}</td></tr>`; }).join("");
    return `<div class="panel-head"><h3>Weather · ${fmtDate(w.date || nf.date)}</h3><span class="muted small">Every RAWS (FEMS) and ASOS/AWOS (Iowa Environmental Mesonet) in the PSA, quality-checked; ERC-Y/BI-Y at 13:00 from the SWCC station list (archive only)</span></div>
      ${w.asosError ? `<p class="warn small">ASOS/AWOS weren't added on this run: ${esc(w.asosError)}</p>` : ""}
      <div class="table-wrap"><table class="raws-table"><thead><tr><th>PSA</th><th class="num" title="RAWS + ASOS/AWOS stations reporting">Stns (RAWS + ASOS)</th><th class="num">Max °F (avg)</th><th class="num">Min RH % (avg)</th><th class="num">Lowest RH %</th><th class="num">Max gust mph</th><th class="num">Precip in (avg)</th><th class="num">Wetting rain stns</th><th>Wind event</th><th class="num">ERC-Y</th><th class="num">BI-Y</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${rawsChecks(w)}`;
  }

  function rawsChecks(w) {
    const list = (w && w.checks) || [];
    if (!w || !w.byPsa) return "";
    if (!list.length) return `<p class="small import-ok">Quality checks: every reading passed.</p>`;
    const dropped = list.filter((c) => c.action === "dropped").length;
    const keptWind = list.filter((c) => /wind event/.test(c.action)).length;
    const rows = list.map((c) => `<tr><td class="psa-id">${esc(c.psa)}</td><td>${esc(c.name || c.id)}${c.network === "ASOS/AWOS" ? ` <span class="tag">ASOS/AWOS</span>` : ""}</td><td>${esc(c.field)}</td><td>${esc(c.hour || "day")}</td><td class="num">${esc(c.value)}</td><td>${esc(c.reason)}</td><td class="${c.action === "dropped" ? "warn" : /wind event/.test(c.action) ? "import-ok" : ""}">${esc(c.action)}</td></tr>`).join("");
    return `<details class="help"><summary>Quality checks removed ${dropped} reading${dropped === 1 ? "" : "s"}${keptWind ? `, kept ${keptWind} high gust${keptWind === 1 ? "" : "s"} as a wind event` : ""}${list.length - dropped - keptWind ? `, flagged ${list.length - dropped - keptWind} to look at` : ""}</summary>
      <div class="table-wrap"><table><thead><tr><th>PSA</th><th>Station</th><th>Reading</th><th>Hour</th><th class="num">Value</th><th>Why</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted small">Removed readings are left out of the PSA numbers above. Checks: physical limits, FEMS suspicious flags, one-hour spikes, stuck sensors, stations far from the rest of their PSA, and gauge resets. A high or odd-looking gust is kept as a wind event only when something backs it up at a similar strength: the station's own sustained wind (40% of the gust), the hour before or after (70%), another RAWS or ASOS/AWOS in the PSA within 2 hours (60%), or an outflow signature for gusts up to 75 mph. Over 90 mph only another station (half the gust) can back it up. The rules are spelled out on the <a href="#calc">Calculations</a> page. Known events can be listed in <code>windEvents</code> in js/config.js.</p></details>`;
  }
  SUMMARY.history = () => {
    if (!archive.loaded) return `<p class="muted">Loading the archive…</p>`;
    const days = joinedDays();
    if (!archive.history.length && !archive.daily.length) return `<div class="panel-head"><h3>PL score and new fire starts</h3></div>
      <div class="chart-empty"><p><b>No archived runs on this site yet.</b></p><p class="muted small">The chart appears after the update job runs once (8 AM or 9 PM Mountain, or <b>Actions → Update PL data → Run workflow</b> on GitHub). If runs have happened but nothing shows here, the repository's <code>.github/workflows/update-data.yml</code> is an older copy that doesn't save the archive; replace it with the current one. The first run also fills in this year's fire starts from WFIGS; the PL line then grows by one point a day.</p></div>${downloads()}`;
    return `${archive.example ? `<p class="warn small">Example data for this preview. The real archive fills in from the scheduled runs.</p>` : ""}
      <div class="panel-head"><h3>PL score and new fire starts</h3><span class="legend"><span><i style="background:var(--ink)"></i>PL score (morning run)</span><span><i style="background:var(--c-light)"></i>Lightning</span><span><i style="background:var(--c-human)"></i>Human</span><span><i style="background:var(--c-unk)"></i>Unknown</span></span></div>
      <figure class="chart">${historyChart(days.filter((d) => d.date >= Review.addDays(days[days.length - 1].date, -119)))}</figure>
      <p class="muted small">The last 120 days. Every day ever archived, any date range or season, and whether the criteria are working are on <a href="#review">Season Review</a>.</p>
      ${archive.history.length < 2 ? `<p class="muted small">${archive.history.length ? "One run archived so far" : "No runs archived yet"}: the PL line builds up one point a day from the first scheduled run. Fire starts before that come from WFIGS.</p>` : ""}
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
    // published PL as a coloured strip under the plot
    const cw = (W - L - R) / n;
    const strip = days.map((d, i) => (d.run && n0(d.run.pl) ? `<rect x="${(L + i * cw).toFixed(2)}" y="${H - B + 3}" width="${(cw + 0.4).toFixed(2)}" height="7" fill="var(--pl${n0(d.run.pl)})"><title>${d.date}: published PL${d.run.pl}</title></rect>` : "")).join("");
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
    if (!archive.history.length) return "";
    const list = archive.allRuns ? archive.history.slice().reverse() : archive.history.slice(-14).reverse();
    const rows = list.map((h) => `<tr><td>${fmtDate(h.run_time, true)}</td><td><span class="pl-mini" data-pl="${h.pl}">PL${h.pl}</span></td><td class="num">${(+h.score).toFixed(3)}</td>
      <td>${chip(h.fire_rating)}</td><td>${chip(h.imt_rating, false, true)}</td><td>${chip(h.crews_rating, false, true)}</td><td>${chip(h.outlook_rating)}</td><td>${chip(h.danger_rating)}</td>
      <td class="num">${h.starts_total || "–"}</td><td>${h.snapshot && !archive.example ? `<a href="${esc(h.snapshot)}" target="_blank" rel="noopener">data</a>` : ""}</td></tr>`).join("");
    const more = archive.history.length > 14 ? `<button class="btn" data-act="all-runs">${archive.allRuns ? "Show the last 14 only" : `Show all ${archive.history.length} runs`}</button>` : "";
    return `<div class="panel-head"><h3>${archive.allRuns ? `All ${archive.history.length} runs` : "Recent runs"}</h3>${more}</div><div class="table-wrap${archive.allRuns ? " tall" : ""}"><table><thead><tr><th>Run</th><th>PL</th><th class="num">Score</th><th>Fire</th><th>IMTs</th><th>Crews</th><th>7-Day</th><th>ERCy</th><th class="num">Starts (prev. day)</th><th>Snapshot</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  const RESOURCE_FILES = [["crews_daily.csv", "Every crew (SWA Type 1 IHC, OOA Type 1 IHC, SWA Type 2IA) with its status, location and incident, every run"],
    ["imts_daily.csv", "Every IMT with its status and incident, every run"]];
  function downloads() {
    const files = [["history.csv", "Every run: PL, score, each element's rating and inputs, previous-day starts and RAWS"],
      ["fire_starts_daily.csv", "New starts per day by cause, acres, and per PSA"], ["fire_starts.csv", "Every fire: date, cause, acres, PSA, location"],
      ["outlook_psa_daily.csv", "7-Day Day 1–7 levels per PSA for every issue date"],
      ["ercy_psa_daily.csv", "PSA ERCy/BIy value and percentile for every date (FEMS, worked out like the NFDRSy workbook)"],
      ["ercy_stations_daily.csv", "Each FEMS station's daily ERC and BI behind those values"],
      ["forecast_pl.csv", "Every PL forecast (today + 4 days) made by each run"],
      ["actual_pl.csv", "The actual SW PL each day (NICC / SWCC)"],
      ["published_pl.csv", "PLs published before the archive started (Jan 1 – Nov 16, 2026)"],
      ["raws_daily.csv", "Weather per day and PSA (RAWS + ASOS/AWOS): max temp, min RH, max gust, precip, wind event"],
      ["raws_stations_daily.csv", "The same per station (RAWS and ASOS/AWOS), after the quality checks"],
      ["raws_checks.csv", "Every weather reading the quality checks removed, kept as a wind event, or flagged, and why"],
      ["fems_erc_bi_daily.csv", "FEMS fuel model Y ERC and BI per day and PSA (13:00 reading and daily max)"],
      ["fems_erc_bi_stations.csv", "The same per station, for the SWCC ERC station list"],
      ...RESOURCE_FILES];
    return `<h3>Download the database</h3><ul class="dl-list">${files.map(([f, d]) => `<li><a href="data/archive/${f}" download>${f}</a> <span class="muted small">${d}</span></li>`).join("")}</ul>
      <p class="muted small">Nothing is ever deleted: every run's full data is kept in <code>data/archive/snapshots/</code> and every CSV keeps all its rows. The CSVs open in Excel. <code>history.csv</code> has, for every run, the PL published at the time and <code>model_pl</code>: what the current criteria in js/config.js give for that run (re-scored on every update).</p>`;
  }

  /* ---------- Model & Data ---------- */
  VIEW.model = () => {
    const custom = state.preset === "custom";
    const w = calc.weightsFor(state);
    return `
    ${head("Model &amp; Data", "Choose element weights, move data in and out, and see how the PL is calculated.")}
    <section class="panel"><h3>Crew and IMT archive</h3>
      <p class="small">Every scheduled run saves every crew's and IMT's status, so availability over a season can be looked back on and compared with fire activity.</p>
      <ul class="dl-list">${RESOURCE_FILES.map(([f, d]) => `<li><a href="data/archive/${f}" download>${f}</a> <span class="muted small">${d}</span></li>`).join("")}</ul>
      <p class="muted small">The whole database (weather, fire starts, ERC/BI, forecasts) is under <a href="#history">History &amp; Data</a>.</p></section>
    <div class="grid-2">
      <section class="panel">
        <h3>Element weights</h3>
        <div class="season-box">
          <p><b>Season everyone sees: ${esc(pubSeasonLabel())}</b></p>
          <p class="small">Only the SWCCFireWx GitHub account can switch the season for everyone; the steps are in the repository's README (<i>Switching the season</i>).
        </div>
        ${EDIT_TABS.has("model") ? `<p class="muted small">Picking a season or custom weights below changes the PL in this browser only, to see the difference; it doesn't change what everyone sees.</p>` : ""}
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
    const old = ["shoulder", "season"].map((k) => { const o = calc.oldMethod(state, k); return `${esc(C.weightPresets[k].label.replace(/^Old: | \(for comparison\)$/g, ""))} PL${o.pl} (${fmt3(o.score)})`; }).join(" · ");
    return (Math.abs(t - 1) > 0.001 ? `<p class="warn">Weights add up to ${fmt2(t)}. They should add up to 1.00.</p>` : `<p class="muted small">Weights add up to 1.00.</p>`) +
      `<p class="small">Today with the old spreadsheet method (large-fire rating only, no PL2 hold): ${old}. Every run archives these next to the new PL so the two can be compared in <a href="#history">History &amp; Data</a>.</p>` +
      `<p class="muted small">PL3 and above need fire on the ground: with Fire Activity at Minimum the PL is held at PL${C.plGate.maxPlWithoutFire}.</p>`;
  };

  /* ---------- Season Review: is the criteria working? ---------- */
  const rv = { range: "all", from: "", to: "", method: "model", trial: null };
  VIEW.review = () => `
    ${head("Season Review", "Checks the PL criteria against what actually happened, over every day ever archived. Pick a range (a whole year, a fire season, or any dates), see whether higher PLs and ratings were followed by more fire, and try different criteria against the whole record before changing them for the next season.")}
    <section class="panel no-print" id="rv-controls"></section>
    <div id="summary"><p class="muted">Loading the archive…</p></div>`;
  AFTER.review = [async () => {
    await loadArchive();
    await loadHealthExtras();
    if (view !== "review") return;
    renderReviewControls();
    const sm = $("#summary"); if (sm) sm.innerHTML = SUMMARY.review();
  }];
  function rerenderReview() { renderReviewControls(); const sm = $("#summary"); if (sm) sm.innerHTML = SUMMARY.review(); }
  function reviewDays() { return Review.buildDays(archive, Review.criteria(rv.trial || {})); }
  function rangeOf(all) {
    const last = all.length ? all[all.length - 1].date : new Date().toISOString().slice(0, 10);
    const F = C.review || { fireSeason: ["04-01", "07-31"] };
    if (rv.range === "all") return [all.length ? all[0].date : "", last];
    if (rv.range === "last30") return [Review.addDays(last, -29), last];
    if (rv.range === "last90") return [Review.addDays(last, -89), last];
    if (rv.range === "custom") return [rv.from, rv.to];
    const m = rv.range.match(/^(year|season)-(\d{4})$/);
    if (m) return m[1] === "year" ? [`${m[2]}-01-01`, `${m[2]}-12-31`] : [`${m[2]}-${F.fireSeason[0]}`, `${m[2]}-${F.fireSeason[1]}`];
    return ["", last];
  }
  // Judge the published PLs when most days in the range only have an imported PL (nothing to re-score).
  function autoMethod(days) {
    if (rv.methodChosen) return;
    const withPl = days.filter((d) => d.run).length, scorable = days.filter((d) => d.run && d.run.origin !== "imported").length;
    rv.method = scorable >= withPl / 2 ? (rv.trial ? rv.method : "model") : "published";
  }
  function renderReviewControls() {
    const box = $("#rv-controls"); if (!box) return;
    const all = reviewDays();
    { const [f0, t0] = rangeOf(all); autoMethod(Review.inRange(all, f0, t0)); }
    const years = [...new Set(all.map((d) => d.date.slice(0, 4)))].sort().reverse();
    const F = C.review || { fireSeason: ["04-01", "07-31"] };
    const fs = `${+F.fireSeason[0].slice(0, 2)}/${+F.fireSeason[0].slice(3)}–${+F.fireSeason[1].slice(0, 2)}/${+F.fireSeason[1].slice(3)}`;
    const opts = [["all", "Everything archived"], ["last30", "Last 30 days"], ["last90", "Last 90 days"],
      ...years.flatMap((y) => [[`year-${y}`, `${y} (whole year)`], [`season-${y}`, `${y} fire season (${fs})`]]), ["custom", "Pick dates…"]];
    const [f, t] = rangeOf(all);
    box.innerHTML = `<div class="row rv-row">
      <label class="field"><span>Range</span><select id="rv-range">${opts.map(([k, l]) => `<option value="${k}" ${rv.range === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label class="field"><span>From</span><input type="date" id="rv-from" value="${esc(f)}"></label>
      <label class="field"><span>To</span><input type="date" id="rv-to" value="${esc(t)}"></label>
      <label class="field"><span>Judge which PL</span><select id="rv-method">${Object.entries(Review.methodsFor(Boolean(rv.trial))).map(([k, m]) => `<option value="${k}" ${rv.method === k ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
      <div class="btn-row"><button class="btn" data-act="rv-xlsx">Download this review (Excel)</button></div></div>
      ${trialPanel()}`;
  }
  function onReviewInput(el) {
    if (el.id === "rv-range") rv.range = el.value;
    if (el.id === "rv-from" || el.id === "rv-to") { rv.range = "custom"; rv.from = $("#rv-from").value; rv.to = $("#rv-to").value; }
    if (el.id === "rv-method") { rv.method = el.value; rv.methodChosen = true; }
    rerenderReview();
  }
  /* what-if criteria */
  function trialPanel() {
    const c = Review.criteria(rv.trial || {}), M = c.fireActivityModel;
    const n = (id, v, step = "1", w = "w-xs") => `<input type="number" class="${w}" id="rv-t-${id}" value="${v}" step="${step}" min="0">`;
    return `<details class="help rv-trial" ${rv.trial ? "open" : ""}><summary>Try different criteria${rv.trial ? " · <b>trial applied</b>" : ""}</summary>
      <p class="small muted">Change any of these and press <b>Apply</b>: every archived run is re-scored with them, and the tables below add a "Trial criteria" column next to the current criteria. Nothing changes on the live site until the numbers are put in <code>js/config.js</code>.</p>
      <div class="trial-grid">
        <div><h4>Weights</h4><p class="muted small">Starts at the season in use now (${esc(pubSeasonLabel())}). Left as they are, each day is re-scored with the season it was run with; changed, they're tried on every day.</p><div class="row">
          <label class="field"><span>Fire Activity</span>${n("w-fire", c.weights.fire, "0.05")}</label>
          <label class="field"><span>7-Day</span>${n("w-outlook", c.weights.outlook, "0.05")}</label>
          <label class="field"><span>ERCy</span>${n("w-danger", c.weights.danger, "0.05")}</label>
          <label class="field"><span>IMTs</span>${n("w-imt", c.weights.imt, "0.05")}</label>
          <label class="field"><span>Crews</span>${n("w-crews", c.weights.crews, "0.05")}</label></div></div>
        <div><h4>PL lines (score at which each PL starts)</h4><div class="row">${c.plLevels.slice(1).map((l) => `<label class="field"><span>PL${l.pl}</span>${n(`pl-${l.pl}`, l.min, "0.005")}</label>`).join("")}</div>
          <label class="field"><span>Hold PL without fire on the ground at (0 = no hold)</span>${n("gate", c.plGate.maxPlWithoutFire || 0)}</label></div>
        <div><h4>Starts per day (3-day avg) for Low / Mod / High / Max</h4><div class="row">${M.startsPerDay.map((b, i) => `<label class="field"><span>${b.rating}</span>${n(`s-${i}`, b.atLeast, "0.5")}</label>`).join("")}</div></div>
        <div><h4>Escapes for Low / Mod / High / Max</h4><div class="row">${M.escapes.map((b, i) => `<label class="field"><span>${b.rating}</span>${n(`e-${i}`, b.atLeast)}</label>`).join("")}</div></div>
        <div><h4>Resources busy in the Southwest (+1 step)</h4><div class="row">
          <label class="field"><span>CIMTs on SW incidents ≥</span>${n("cap-cimt", M.capacity.minCimtCommittedInSw)}</label>
          <label class="field"><span>Type 3 teams on SW incidents ≥</span>${n("cap-t3", M.capacity.minT3CommittedInSw)}</label>
          <label class="field"><span>Crews in the SW committed ≥ %</span>${n("cap-crew", Math.round(M.capacity.minCrewShareCommittedInSw * 100))}</label></div></div>
        <div><h4>7-Day rising (+1 step)</h4><div class="row">
          <label class="field"><span>Days 4–7 above days 1–3 by</span>${n("o-rise", M.outlook.risingBy, "0.5")}</label>
          <label class="field"><span>High-risk PSA-days ≥</span>${n("o-hr", M.outlook.minHighRiskPsaDays)}</label></div></div>
        <div><h4>7-Day rating: average score below…</h4><div class="row">${c.outlookBands.filter((b) => Number.isFinite(b.below)).map((b, i) => `<label class="field"><span>${b.rating}</span>${n(`ob-${i}`, b.below)}</label>`).join("")}</div></div>
        <div><h4>ERCy Extreme when PSAs at 97th+ ≥</h4>${n("ex", c.extremeCount)}</div>
        <div><h4>SWA Type 2IA crews</h4><select id="rv-t-t2ia">${[["", "As each run had it"], ["yes", "Count them"], ["no", "Don't count them"]].map(([v, l]) => `<option value="${v}" ${(c.includeT2IA === true ? "yes" : c.includeT2IA === false ? "no" : "") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
          <p class="muted small">Uses each run's crew availability worked out both ways (archived from Nov 19, 2026 on).</p></div>
      </div>
      <div class="btn-row"><button class="btn primary" data-act="rv-apply">Apply to the whole archive</button>${rv.trial ? `<button class="btn" data-act="rv-clear">Clear the trial</button><button class="btn" data-act="rv-copy">Copy as js/config.js settings</button>` : ""}</div>
      ${rv.trial ? `<textarea id="rv-snippet" class="snippet" readonly>${esc(trialSnippet())}</textarea>` : ""}
    </details>`;
  }
  function readTrial() {
    const v = (id) => { const e = $(`#rv-t-${id}`); const x = e ? parseFloat(e.value) : NaN; return Number.isFinite(x) ? x : 0; };
    const base = Review.criteria();
    const R4 = ["Low", "Moderate", "High", "Maximum"];
    const weights = { fire: v("w-fire"), outlook: v("w-outlook"), danger: v("w-danger"), imt: v("w-imt"), crews: v("w-crews") };
    return {
      weights,
      // unchanged weights: each day keeps the season it was run with; changed weights are tried on every day
      bySeason: C.elements.every((e) => Math.abs((weights[e.key] || 0) - (base.weights[e.key] || 0)) < 1e-9),
      plLevels: base.plLevels.map((l) => (l.pl === 1 ? l : { ...l, min: v(`pl-${l.pl}`) })),
      plGate: { maxPlWithoutFire: v("gate") },
      fireActivityModel: {
        startsPerDay: R4.map((r, i) => ({ rating: r, atLeast: v(`s-${i}`) })),
        escapes: R4.map((r, i) => ({ rating: r, atLeast: v(`e-${i}`) })),
        capacity: { minCimtCommittedInSw: v("cap-cimt"), minT3CommittedInSw: v("cap-t3"), minCrewShareCommittedInSw: v("cap-crew") / 100 },
        outlook: { risingBy: v("o-rise"), minHighRiskPsaDays: v("o-hr") },
      },
      outlookBands: base.outlookBands.map((b, i) => (Number.isFinite(b.below) ? { ...b, below: v(`ob-${i}`) } : b)),
      extremeCount: v("ex"),
      includeT2IA: ($("#rv-t-t2ia") || {}).value === "yes" ? true : ($("#rv-t-t2ia") || {}).value === "no" ? false : undefined,
    };
  }
  function trialSnippet() {
    const c = Review.criteria(rv.trial || {}), M = c.fireActivityModel;
    return `// Trial criteria from the Season Review (${new Date().toLocaleDateString()}). Put these in js/config.js:
weightPresets.${(published && published.preset) || C.defaultPreset}.weights = ${JSON.stringify(c.weights)};
plLevels = ${JSON.stringify(c.plLevels)};
plGate = ${JSON.stringify(c.plGate)};
fireActivityModel.startsPerDay = ${JSON.stringify(M.startsPerDay)};
fireActivityModel.escapes = ${JSON.stringify(M.escapes)};
fireActivityModel.capacity = ${JSON.stringify(M.capacity)};
fireActivityModel.outlook.risingBy = ${M.outlook.risingBy}; fireActivityModel.outlook.minHighRiskPsaDays = ${M.outlook.minHighRiskPsaDays};
outlook.bands = ${JSON.stringify(c.outlookBands).replace(/null/g, "Infinity")};
danger.extremeCount = ${c.extremeCount};${c.includeT2IA !== undefined ? `\ncrewAvailability.includeT2IA = ${c.includeT2IA};` : ""}`;
  }
  function reviewData() {
    const all = reviewDays();
    const [from, to] = rangeOf(all);
    let days = Review.inRange(all, from, to);
    if (rv.trial) days = Review.withTrial(days, Review.criteria(rv.trial));
    const methods = Review.methodsFor(Boolean(rv.trial));
    if (!methods[rv.method]) rv.method = "model";
    autoMethod(days);
    const m = methods[rv.method];
    const plOf = (d) => m.pl(d), scoreOf = (d) => m.score(d);
    const cri = Review.criteria(rv.trial || {});
    return { all, days, from, to, methods, m, plOf, scoreOf, cri,
      outcomes: Review.plOutcomes(days, methods), elements: Review.elementOutcomes(days, Boolean(rv.trial)),
      th: Review.thresholds(days, cri), outlook: Review.outlookCheck(archive, from, to), ercy: Review.ercyCheck(archive, from, to),
      wx: Review.weatherCheck(archive, from, to), miss: Review.misses(days, plOf), stab: Review.stability(days, plOf),
      corr: Review.correlation(days, (d) => scoreOf(d) ?? plOf(d)) };
  }
  const pctS = (v) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  const dash = (v) => (v === null || v === undefined ? "–" : v);
  const verdict = (v) => (v ? `<p class="verdict ${v.status}">${v.status === "ok" ? "✓" : v.status === "warn" ? "⚠" : "…"} ${esc(v.text)}</p>` : "");
  SUMMARY.review = () => {
    if (!archive.loaded) return `<p class="muted">Loading the archive…</p>`;
    if (!archive.history.length && !archive.daily.length) return `<section class="panel"><div class="chart-empty"><p><b>Nothing archived yet.</b></p><p class="muted small">The review fills in from the scheduled runs. Run the job once from <b>Actions → Update PL data → Run workflow</b>; it also fills in this year's fire starts.</p></div></section>`;
    const D = reviewData(), { days } = D;
    if (!days.length) return `<section class="panel"><p class="muted">No archived days in that range.</p></section>`;
    const runDays = days.filter((d) => d.run);
    const sum = (k) => days.reduce((a, d) => a + (d[k] || 0), 0);
    const tiles = `<div class="stats rv-stats">
      <div class="stat"><span class="k">Days</span><span class="v">${days.length}</span><span class="small muted">${runDays.length} with a PL${runDays.some((d) => d.run.origin === "imported") ? ` (${runDays.filter((d) => d.run.origin === "imported").length} from the imported published PLs)` : ""}</span></div>
      <div class="stat"><span class="k">New starts</span><span class="v">${sum("total")}</span><span class="small muted">${sum("lightning")} lightning · ${sum("human")} human</span></div>
      <div class="stat"><span class="k">Acres (new starts)</span><span class="v">${Math.round(sum("acres")).toLocaleString()}</span></div>
      <div class="stat"><span class="k">Highest PL</span><span class="v">${D.stab.highest ? `PL${D.stab.highest}` : "–"}</span><span class="small muted">${esc(D.m.label)}</span></div>
      <div class="stat"><span class="k">PL changes</span><span class="v">${D.stab.changes}</span><span class="small muted">${D.stab.flips} quick reversal${D.stab.flips === 1 ? "" : "s"}</span></div>
      <div class="stat"><span class="k">PL vs next 7 days' starts</span><span class="v">${D.corr ?? "–"}</span><span class="small muted">correlation (1 = moves together)</span></div>
    </div>`;
    const sec = (title, body, cls = "") => `<section class="panel rv-sec ${cls}"><h3>${title}</h3>${body}</section>`;

    // 1. timeline
    const s1 = sec(`PL score and new fire starts · ${fmtDate(D.from)} – ${fmtDate(D.to)}`, `
      <div class="legend rv-legend"><span><i style="background:var(--ink)"></i>${esc(D.methods.model.label)}</span>${rv.trial ? `<span><i style="background:#0e9f9a"></i>Trial criteria</span>` : ""}<span><i class="dash" style="border-color:var(--muted)"></i>Old: fire season</span><span><i style="background:linear-gradient(90deg,var(--pl1),var(--pl2),var(--pl3),var(--pl4))"></i>Published PL (strip under the chart)</span><span><i style="background:var(--c-light)"></i>Lightning</span><span><i style="background:var(--c-human)"></i>Human</span><span><i style="background:var(--c-unk)"></i>Unknown</span></div>
      <figure class="chart">${reviewChart(days)}</figure>`);

    // 2. PL by method
    const mrows = Object.entries(D.outcomes).map(([k, o]) => `<tr${k === rv.method ? ' class="on"' : ""}><td>${esc(o.label)}</td>${o.rows.map((r) => `<td class="num">${r.days ? `${r.days} <span class="muted small">(${pctS(r.share)})</span>` : "–"}</td>`).join("")}<td class="num">${o.n}</td></tr>`).join("");
    const sel = D.outcomes[rv.method];
    const orows = sel.rows.map((r) => `<tr><td><span class="pl-mini" data-pl="${r.pl}">PL${r.pl}</span></td><td class="num">${r.days}</td><td class="num">${dash(r.sameDay)}</td><td class="num"><b>${dash(r.next7)}</b></td><td class="num">${dash(r.maxNext7)}</td><td class="num">${r.next7Acres === null ? "–" : r.next7Acres.toLocaleString()}</td><td class="num">${dash(r.largeFires)}</td><td class="num">${pctS(r.escapeDays)}</td></tr>`).join("");
    const s2 = sec("Does a higher PL mean more fire?", `
      <h4>Days at each PL</h4>
      <div class="table-wrap"><table><thead><tr><th>Method</th>${[1, 2, 3, 4, 5].map((p) => `<th class="num">PL${p}</th>`).join("")}<th class="num">Days</th></tr></thead><tbody>${mrows}</tbody></table></div>
      <h4>What followed each PL · ${esc(sel.label)}</h4>
      <div class="table-wrap"><table><thead><tr><th>PL</th><th class="num">Days</th><th class="num">Starts that day</th><th class="num">Starts next 7 days (avg)</th><th class="num">Most in 7 days</th><th class="num">Acres next 7 days (avg)</th><th class="num">Active T3+ fires (avg)</th><th class="num">Days with an escape</th></tr></thead><tbody>${orows}</tbody></table></div>
      ${verdict(sel.verdict)}
      <p class="small muted">"Current criteria" re-scores every archived run with today's js/config.js, so a season run under older settings can still be judged against the new ones. The old methods are the spreadsheet's shoulder-season and fire-season weightings.</p>`);

    // 3. elements
    const thin = D.elements.filter((e) => e.rows.reduce((a, r) => a + r.days, 0) < 10);
    const s3 = sec(`Does each element line up with fire?${rv.trial ? " · trial criteria" : ""}`, (thin.length ? `<p class="verdict few">… ${thin.map((e) => esc(e.label.replace(/ \(.*\)$/, ""))).join(", ")}: ${(() => { const k = Math.max(0, ...thin.map((e) => e.rows.reduce((a, r) => a + r.days, 0))); return k ? `only ${k} archived day${k === 1 ? "" : "s"}` : "no archived days"; })()} with these ratings in this range, so they're left out until there are 10+. They come from the tool's own runs; the imported PLs don't have them.</p>` : "") + D.elements.filter((e) => !thin.includes(e)).map((e) => `
      <h4>${esc(e.label)}${e.inverted ? ` <span class="muted small">(availability: fewer available = higher PL)</span>` : ""}</h4>
      <div class="table-wrap"><table><thead><tr><th>Rating</th><th class="num">Days</th><th class="num">Share of days</th><th class="num">Starts next 7 days (avg)</th><th class="num">Acres next 7 days (avg)</th><th class="num">Active T3+ (avg)</th></tr></thead><tbody>
        ${e.rows.map((r) => `<tr><td>${chip(r.rating, false, e.inverted)}</td><td class="num">${r.days}</td><td class="num">${pctS(r.share)}</td><td class="num"><b>${dash(r.next7)}</b></td><td class="num">${r.next7Acres === null ? "–" : r.next7Acres.toLocaleString()}</td><td class="num">${dash(r.largeFires)}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No runs in this range.</td></tr>`}
      </tbody></table></div>${e.notes.map(verdict).join("")}`).join(""));

    // 4. Fire Activity thresholds
    const T = D.th, M = D.cri.fireActivityModel;
    const bandTable = (counts, cur, what) => { const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
      return `<div class="table-wrap"><table><thead><tr><th>Rating</th><th class="num">${what}</th><th class="num">Days with this rating</th><th class="num">Share of days</th></tr></thead><tbody>
      ${["Minimum", "Low", "Moderate", "High", "Maximum"].map((r, i) => `<tr><td>${chip(r)}</td><td class="num">${i ? `${cur[i - 1]}${cur[i] !== undefined ? ` to under ${cur[i]}` : " or more"}` : `under ${cur[0]}`}</td><td class="num">${counts[r] || 0}</td><td class="num">${Math.round(((counts[r] || 0) / total) * 100)}%</td></tr>`).join("")}</tbody></table></div>`; };
    const s4 = sec("Fire Activity criteria against this range", `
      <div class="grid-2">
        <div><h4>New starts per day (3-day average)</h4>
          <p class="small">Half the days had ${dash(T.startsAvg3.p50)} or more; the busiest quarter ${dash(T.startsAvg3.p75)}+, the busiest 10% ${dash(T.startsAvg3.p90)}+, the busiest 3% ${dash(T.startsAvg3.p97)}+; highest ${dash(T.startsAvg3.max)}.</p>
          ${bandTable(T.startsBands, M.startsPerDay.map((b) => b.atLeast), "New starts per day")}
          ${T.suggested ? `<p class="verdict info">Lines set at the 50th / 75th / 90th / 97th percentile of the ${T.fireDayCount} days with fire would be <b>${T.suggested.join(" / ")}</b> (now ${M.startsPerDay.map((b) => b.atLeast).join(" / ")}). Try them under "Try different criteria".</p>` : `<p class="small muted">A suggested set of lines appears once the range has 30+ days with fire.</p>`}</div>
        <div><h4>Escapes (fires found in the last 3 days, still uncontained, 100+ acres or T3+)</h4>
          <p class="small">${T.escapes.n ? `Recorded on ${T.escapes.n} runs; the busiest 10% had ${dash(T.escapes.p90)}+, highest ${dash(T.escapes.max)}.` : "Not recorded in this range yet (it's counted from the Nov 16, 2026 version on)."}</p>
          ${T.escapes.n ? bandTable(T.escapeBands, M.escapes.map((b) => b.atLeast), "Escapes") : ""}
          <h4>Steps and the PL2 hold</h4>
          <p class="small">Resources-busy-in-the-Southwest step on <b>${T.steps.capacity}</b> run days, 7-Day step on <b>${T.steps.outlook}</b>. PL held at PL2 (no fire on the ground) on <b>${T.steps.held}</b> days${T.steps.heldStarts.length ? `; those days were followed by ${(T.steps.heldStarts.reduce((a, b) => a + b, 0) / T.steps.heldStarts.length).toFixed(1)} starts over the next 7 days on average (most ${Math.max(...T.steps.heldStarts)})` : ""}. If held days were often followed by a busy week, the hold may be holding the PL down too long.</p></div>
      </div>`);

    // 5. per-PSA checks
    const psaRows = (rows) => rows.map((r) => `<tr><td>${esc(String(r.level))}</td><td class="num">${r.psaDays}</td><td class="num">${pctS(r.anyStart)}</td><td class="num"><b>${dash(r.avg)}</b></td>${"busy" in r ? `<td class="num">${pctS(r.busy)}</td>` : ""}</tr>`).join("");
    const psaHead = (first, busy = true) => `<thead><tr><th>${first}</th><th class="num">PSA-days</th><th class="num">With a start</th><th class="num">Starts (avg)</th>${busy ? `<th class="num">3+ starts</th>` : ""}</tr></thead>`;
    const anyPsa = (rows) => rows.some((r) => r.psaDays);
    const haveO = anyPsa(D.outlook.rows), haveE = anyPsa(D.ercy.rows), haveW = anyPsa(D.wx.rh) || anyPsa(D.wx.wind);
    const s5 = !(haveO || haveE || haveW) ? sec("PSA by PSA: did the 7-Day and ERCy point to the right places?", `<p class="verdict few">… No archived 7-Day issues, ERCy files or weather with a following 2 days of fire starts in this range yet. These checks fill in from the scheduled runs (7-Day and weather) and the uploaded ERC/BI files.</p>`) : sec("PSA by PSA: did the 7-Day and ERCy point to the right places?", `
      <div class="grid-2">
        <div><h4>7-Day Day 1 level vs starts in that PSA (that day and the next 2)</h4>
          <div class="table-wrap"><table>${psaHead("Day 1 level")}<tbody>${psaRows(D.outlook.rows.map((r) => ({ ...r, level: ["", "1 Little/No", "2 Low", "3 Moderate", "4 High"][r.level] })))}</tbody></table></div>
          ${D.outlook.rows.some((r) => r.psaDays) ? verdict(D.outlook.verdict.startsWith("Not enough") ? { status: "few", text: D.outlook.verdict } : { status: /followed by less/.test(D.outlook.verdict) ? "warn" : "ok", text: D.outlook.verdict }) : `<p class="small muted">Fills in from the archived 7-Day issues (outlook_psa_daily.csv).</p>`}</div>
        <div><h4>ERCy percentile vs starts in that PSA (that day and the next 2)</h4>
          <div class="table-wrap"><table>${psaHead("ERCy")}<tbody>${psaRows(D.ercy.rows)}</tbody></table></div>
          ${D.ercy.rows.some((r) => r.psaDays) ? verdict(D.ercy.verdict.startsWith("Not enough") ? { status: "few", text: D.ercy.verdict } : { status: /followed by less/.test(D.ercy.verdict) ? "warn" : "ok", text: D.ercy.verdict }) : `<p class="small muted">Fills in from the uploaded ERC/BI files (ercy_psa_daily.csv).</p>`}</div>
      </div>
      <h4>Weather vs starts in that PSA the next 2 days (RAWS + ASOS/AWOS)</h4>
      <div class="grid-3">
        <div class="table-wrap"><table>${psaHead("Lowest RH", false)}<tbody>${psaRows(D.wx.rh)}</tbody></table></div>
        <div class="table-wrap"><table>${psaHead("Wind", false)}<tbody>${psaRows(D.wx.wind)}</tbody></table></div>
        <div class="table-wrap"><table>${psaHead("Rain", false)}<tbody>${psaRows(D.wx.rain)}</tbody></table></div>
      </div>
      <p class="small muted">Weather isn't part of the PL score; these show whether it would add something the current elements miss (for example, if dry, windy PSA-days lead to many more starts than the 7-Day or ERCy pick up).</p>`);

    // 5b. forecast vs actual
    const FC = Review.forecastCheck(archive, D.from, D.to);
    const fcRows = FC.rows.map((r) => `<tr><td>${r.lead === 0 ? "Today (this tool's PL)" : `${r.lead} day${r.lead > 1 ? "s" : ""} ahead`}</td><td class="num">${r.n}</td><td class="num"><b>${pctS(r.exact)}</b></td><td class="num">${pctS(r.within1)}</td>
      <td class="num">${r.bias > 0 ? "+" : ""}${r.bias}</td><td class="num">${r.mae}</td><td class="num">${r.lead === 0 ? "–" : pctS(r.persistExact)}</td><td class="num">${r.lead === 0 ? "–" : dash(r.persistMae)}</td></tr>`).join("");
    const sFc = sec("Forecast vs actual PL", FC.rows.length ? `
      <div class="table-wrap"><table><thead><tr><th>Lead</th><th class="num">Forecasts</th><th class="num">Exactly right</th><th class="num">Within 1 PL</th><th class="num">Average error</th><th class="num">Average miss (PLs)</th><th class="num">"No change" exactly right</th><th class="num">"No change" average miss</th></tr></thead><tbody>${fcRows}</tbody></table></div>
      <p class="small muted">Actual PL: NICC (or the SWCC page) each day from Nov 19, 2026 on, and the published PLs before that. Average error above 0 means the forecast ran high. "No change" is the actual PL on the day the forecast was made, carried forward: the forecast is adding something when it beats that.</p>
      ${FC.misses.length ? `<details class="day-more"><summary>Forecasts that missed (${FC.misses.length} most recent)</summary><div class="table-wrap"><table><thead><tr><th>For</th><th>Made</th><th class="num">Lead</th><th class="num">Forecast</th><th class="num">Actual</th><th>Fire Activity</th><th>7-Day</th><th>ERCy</th></tr></thead><tbody>
        ${FC.misses.map((m) => `<tr><td>${fmtDate(m.target)}</td><td>${esc(String(m.issued).slice(5, 16).replace("T", " "))}</td><td class="num">${m.lead}</td><td class="num">PL${m.forecast}</td><td class="num">PL${m.actual}</td><td>${m.fire ? chip(m.fire) : ""}</td><td>${m.outlook ? chip(m.outlook) : ""}</td><td>${m.danger ? chip(m.danger) : ""}</td></tr>`).join("")}</tbody></table></div></details>` : ""}`
      : `<p class="verdict few">… Forecasts are archived from Nov 19, 2026 on (forecast_pl.csv), and checked once the actual PL for their day is in. This fills in over the coming days.</p>`);

    // 5c. days the official PL differed from the tool, with the reasons
    const diffs = (health.compare || []).filter((r) => r.differs === "yes" && (!D.from || r.date >= D.from) && (!D.to || r.date <= D.to));
    const rmap = Object.fromEntries((health.reasons || []).map((r) => [String(r.date).slice(0, 10), r]));
    const sDiff = diffs.length ? sec("When the official PL differed from the tool", `<div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Official</th><th class="num">Tool</th><th>Reason</th></tr></thead><tbody>
      ${diffs.map((r) => `<tr><td>${fmtDate(r.date)}</td><td class="num">PL${r.official_pl}</td><td class="num">PL${r.tool_pl}</td><td>${rmap[r.date] && rmap[r.date].reason ? esc(rmap[r.date].reason) : `<span class="warn-t">no reason yet</span>`}</td></tr>`).join("")}</tbody></table></div>
      <p class="small muted">${diffs.length} day${diffs.length > 1 ? "s" : ""} in this range. The reasons are the best guide to what the criteria are missing.</p>`) : "";
    // criteria versions in the range
    const vers = [...new Set(days.filter((d) => d.run && d.run.criteria_version).map((d) => `${d.run.criteria_version}|${d.run.criteria_fingerprint}`))];
    const verNote = vers.length > 1 ? `<p class="warn small">This range mixes ${vers.length} versions of the criteria (${vers.map((v) => { const [l, fp] = v.split("|"); const ds = days.filter((d) => d.run && d.run.criteria_version === l && d.run.criteria_fingerprint === fp).map((d) => d.date); return `${esc(l || "unlabelled")} ${fmtDate(ds[0])}–${fmtDate(ds[ds.length - 1])}`; }).join("; ")}). "Published at the time" changes criteria partway; "Current criteria" re-scores every run with today's.</p>` : "";

    // 6. days to look at
    const ch = (r) => (r ? chip(r) : `<span class="muted">–</span>`);
    const mr = (list) => list.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>PL</th><th>New-starts load</th><th>Fire Activity</th><th>7-Day</th><th>ERCy</th><th class="num">Starts that day</th><th class="num">Lightning</th><th class="num">Next 7 days</th><th class="num">Acres next 7</th></tr></thead><tbody>
      ${list.map((d) => `<tr><td>${fmtDate(d.date)}</td><td><span class="pl-mini" data-pl="${D.plOf(d)}">PL${D.plOf(d)}</span></td><td>${ch(d.iaStarts)}${d.starts3 !== null ? ` <span class="muted small">${d.starts3}/day</span>` : ""}</td><td>${ch((d.trial && d.trial.ratings.fire) || d.run.model_fire_rating || d.run.fire_rating)}</td><td>${ch(d.run.outlook_rating)}</td><td>${ch(d.run.danger_rating)}</td><td class="num">${dash(d.total)}</td><td class="num">${dash(d.lightning)}</td><td class="num"><b>${d.next7}</b></td><td class="num">${d.next7Acres === null ? "–" : Math.round(d.next7Acres).toLocaleString()}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted">None.</p>`;
    const s6 = sec(`Days to look at · ${esc(D.m.label)}`, D.miss.cut ? `
      <h4>PL looked low: PL1–2, but the next 7 days were among the busiest 10% (${D.miss.cut.hi}+ starts)</h4>${mr(D.miss.low)}
      <h4>PL looked high: PL3+, but the next 7 days were among the quietest quarter (${D.miss.cut.lo} or fewer starts)</h4>${mr(D.miss.high)}
      <p class="small muted">These are the days worth pulling up in a season review: what was known that morning, and which element should have moved.</p>` : `<p class="muted small">Needs 10+ days with a PL run and a full following week.</p>`);

    return `${archive.example ? `<p class="warn small">Example data for this preview. The real review fills in from the scheduled runs.</p>` : ""}
      ${verNote}${tiles}${s1}${s2}${sFc}${sDiff}${s3}${s4}${s5}${s6}`;
  };
  function reviewChart(days) {
    const W = 760, H = 290, L = 44, R = 44, T = 20, B = 44;
    const n = days.length, bw = Math.max(1, ((W - L - R) / n) * 0.75);
    const x = (i) => L + ((i + 0.5) * (W - L - R)) / n;
    const maxS = Math.max(4, ...days.map((d) => d.total || 0));
    const ys = (v) => T + (1 - v / maxS) * (H - T - B), yp = (v) => T + (1 - v) * (H - T - B);
    const bands = C.plLevels.map((l, i) => { const top = (C.plLevels[i + 1] || { min: 1 }).min;
      return `<rect x="${L}" width="${W - L - R}" y="${yp(top)}" height="${yp(l.min) - yp(top)}" fill="var(--pl${l.pl})" opacity=".08"/>`; }).join("");
    const bars = days.map((d, i) => { if (!d.starts) return "";
      let y0 = H - B;
      return [["lightning", "var(--c-light)"], ["human", "var(--c-human)"], ["unknown", "var(--c-unk)"]].map(([k, c]) => { const v = n0(d.starts[k]) || 0; if (!v) return ""; const h = (H - T - B) * (v / maxS); y0 -= h;
        return `<rect x="${x(i) - bw / 2}" y="${y0}" width="${bw}" height="${h}" fill="${c}"><title>${d.date}: ${v} ${k}</title></rect>`; }).join(""); }).join("");
    const line = (get, style) => { const segs = []; let cur = [];
      days.forEach((d, i) => { const v = d.run ? get(d) : null; if (v === null || v === undefined || !Number.isFinite(+v)) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${x(i).toFixed(1)},${yp(+v).toFixed(1)}`); });
      if (cur.length) segs.push(cur);
      return segs.map((p) => (p.length > 1 ? `<polyline points="${p.join(" ")}" fill="none" ${style}/>` : `<circle cx="${p[0].split(",")[0]}" cy="${p[0].split(",")[1]}" r="2.5" ${style.replace("stroke=", "fill=")}/>`)).join(""); };
    const lines = line((d) => n0(d.run.old_season_score), `stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 3"`)
      + (rv.trial ? line((d) => d.trial && d.trial.score, `stroke="#0e9f9a" stroke-width="2.25"`) : "")
      + line((d) => n0(d.run.model_score !== "" && d.run.model_score !== undefined ? d.run.model_score : d.run.score), `stroke="var(--ink)" stroke-width="2"`);
    const yl = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${L - 6}" y="${yp(v) + 4}" text-anchor="end">${v}</text>`).join("");
    const yr = [0, Math.round(maxS / 2), maxS].map((v) => `<text x="${W - R + 6}" y="${ys(v) + 4}">${v}</text>`).join("");
    // published PL as a coloured strip under the plot
    const cw = (W - L - R) / n;
    const strip = days.map((d, i) => (d.run && n0(d.run.pl) ? `<rect x="${(L + i * cw).toFixed(2)}" y="${H - B + 3}" width="${(cw + 0.4).toFixed(2)}" height="7" fill="var(--pl${n0(d.run.pl)})"><title>${d.date}: published PL${d.run.pl}</title></rect>` : "")).join("");
    const step = Math.ceil(n / 8);
    const xl = days.map((d, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${n > 400 ? d.date.slice(0, 7) : `${+d.date.slice(5, 7)}/${+d.date.slice(8)}${n > 200 ? `/${d.date.slice(2, 4)}` : ""}`}</text>` : "")).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PL score and daily new fire starts">${bands}${bars}${lines}${strip}${yl}${yr}${xl}
      <text x="4" y="12" class="axis">PL score</text><text x="${W - R + 6}" y="12" class="axis">Starts</text></svg>`;
  }
  function exportReview() {
    const D = reviewData();
    const H = (v) => ({ v, s: "head" }), B = (v) => ({ v, s: "bold" });
    const sheets = [];
    sheets.push({ name: "Summary", cols: [34, 18], rows: [
      [{ v: "SWA PL Season Review", s: "title" }], [{ v: `${D.from} to ${D.to} · judged on: ${D.m.label}${rv.trial ? " (trial criteria applied)" : ""}`, s: "sub" }], [],
      [B("Days"), D.days.length], [B("Days with a PL run"), D.days.filter((d) => d.run).length],
      [B("New starts"), D.days.reduce((a, d) => a + (d.total || 0), 0)], [B("Highest PL"), D.stab.highest ? `PL${D.stab.highest}` : ""],
      [B("PL changes"), D.stab.changes], [B("Quick reversals"), D.stab.flips], [B("Correlation: score vs next-7-day starts"), D.corr ?? ""],
      [], [B("Verdict: does a higher PL mean more fire?"), D.outcomes[rv.method].verdict.text],
      ...D.elements.flatMap((e) => e.notes.map((nt) => [B(e.label), nt.text])),
      ...(rv.trial ? [[], [B("Trial criteria (for js/config.js)")], ...trialSnippet().split("\n").map((l) => [l])] : []) ] });
    sheets.push({ name: "PL by method", cols: [28, 10, 10, 10, 10, 10, 10], rows: [
      [H("Method"), H("PL1"), H("PL2"), H("PL3"), H("PL4"), H("PL5"), H("Days")],
      ...Object.values(D.outcomes).map((o) => [o.label, ...o.rows.map((r) => r.days), o.n]), [],
      [H("Method"), H("PL"), H("Days"), H("Starts that day"), H("Starts next 7 days"), H("Most in 7 days"), H("Acres next 7 days"), H("Active T3+"), H("Days with escape")],
      ...Object.values(D.outcomes).flatMap((o) => o.rows.map((r) => [o.label, `PL${r.pl}`, r.days, r.sameDay ?? "", r.next7 ?? "", r.maxNext7 ?? "", r.next7Acres ?? "", r.largeFires ?? "", r.escapeDays === null ? "" : Math.round(r.escapeDays * 100) / 100])) ] });
    sheets.push({ name: "Elements", cols: [20, 12, 8, 12, 18, 18, 12], rows: [
      [H("Element"), H("Rating"), H("Days"), H("Share"), H("Starts next 7 days"), H("Acres next 7 days"), H("Active T3+")],
      ...D.elements.flatMap((e) => e.rows.map((r) => [e.label, { v: r.rating, s: r.rating }, r.days, Math.round(r.share * 100) / 100, r.next7 ?? "", r.next7Acres ?? "", r.largeFires ?? ""])) ] });
    const T = D.th;
    sheets.push({ name: "Fire Activity lines", cols: [36, 12, 12, 12, 12, 12], rows: [
      [H("Starts/day (3-day avg)"), H("50th"), H("75th"), H("90th"), H("97th"), H("Max")],
      ["All days", T.startsAvg3.p50, T.startsAvg3.p75, T.startsAvg3.p90, T.startsAvg3.p97, T.startsAvg3.max],
      [B("Current lines Low/Mod/High/Max"), ...T.current], ...(T.suggested ? [[B("Percentile lines (days with fire)"), ...T.suggested]] : []), [],
      [H("Band"), H("Days")], ...Object.entries(T.startsBands).map(([k, v]) => [{ v: k, s: k }, v]), [],
      [B("Resources-busy step days"), T.steps.capacity], [B("7-Day step days"), T.steps.outlook], [B("Days held at PL2"), T.steps.held] ] });
    const psa = (title, rows) => [[H(title), H("PSA-days"), H("With a start"), H("Starts (avg)")], ...rows.map((r) => [String(r.level), r.psaDays, r.anyStart === null ? "" : Math.round(r.anyStart * 100) / 100, r.avg ?? ""]), []];
    sheets.push({ name: "PSA checks", cols: [22, 12, 14, 14], rows: [...psa("7-Day Day 1 level", D.outlook.rows), ...psa("ERCy percentile", D.ercy.rows), ...psa("Lowest RH", D.wx.rh), ...psa("Wind", D.wx.wind), ...psa("Rain", D.wx.rain)] });
    const dayRow = (d) => [d.date, D.plOf(d) || "", d.run ? d.run.pl : "", d.run ? d.run.model_pl : "", d.trial ? d.trial.pl : "", d.run ? d.run.old_shoulder_pl : "", d.run ? d.run.old_season_pl : "",
      d.run ? (d.trial ? d.trial.ratings.fire : d.run.model_fire_rating || d.run.fire_rating) : "", d.run ? d.run.outlook_rating : "", d.run ? d.run.danger_rating : "", d.run ? d.run.imt_rating : "", d.run ? d.run.crews_rating : "",
      d.total ?? "", d.lightning ?? "", d.human ?? "", d.acres ?? "", d.starts3 ?? "", d.next7 ?? "", d.next7Acres ?? ""];
    sheets.push({ name: "Days to look at", cols: [12, 8, 10, 10, 10, 10, 10, 14, 12, 12, 12, 12, 10, 10, 10, 10, 10, 12, 12], rows: [
      [B("PL looked low")], [H("Date"), H("PL judged"), H("Published"), H("Current"), H("Trial"), H("Old shoulder"), H("Old season"), H("Fire Activity"), H("7-Day"), H("ERCy"), H("IMTs"), H("Crews"), H("Starts"), H("Lightning"), H("Human"), H("Acres"), H("3-day avg"), H("Next 7 days"), H("Acres next 7")],
      ...D.miss.low.map(dayRow), [], [B("PL looked high")], ...D.miss.high.map(dayRow) ] });
    sheets.push({ name: "Every day", cols: [12, 8, 10, 10, 10, 10, 10, 14, 12, 12, 12, 12, 10, 10, 10, 10, 10, 12, 12], rows: [
      [H("Date"), H("PL judged"), H("Published"), H("Current"), H("Trial"), H("Old shoulder"), H("Old season"), H("Fire Activity"), H("7-Day"), H("ERCy"), H("IMTs"), H("Crews"), H("Starts"), H("Lightning"), H("Human"), H("Acres"), H("3-day avg"), H("Next 7 days"), H("Acres next 7")],
      ...D.days.map(dayRow) ] });
    downloadBytes(window.PL_XLSX(sheets), `SWA_PL_Season_Review_${D.from}_to_${D.to}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  /* ---------- Data Health: everything that isn't working right, in one place ---------- */
  // Times in the data are Mountain Time (America/Denver) without a zone; compare them in that zone.
  const mtNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
  const hoursSince = (t) => (t ? (Date.parse(mtNow() + ":00Z") - Date.parse(String(t).slice(0, 16).padEnd(16, "T00:00").replace(/^(\d{4}-\d{2}-\d{2})$/, "$1T00:00") + ":00Z")) / 36e5 : Infinity);
  const ago = (t) => { const h = hoursSince(t); if (!Number.isFinite(h)) return "never"; if (h < 1) return "under an hour ago"; if (h < 48) return `${Math.round(h)} hours ago`; return `${Math.round(h / 24)} days ago`; };
  const inFireSeason = (iso) => { const md = String(iso).slice(5, 10), F = (C.health || {}).fireSeason || ["04-01", "09-30"]; return md >= F[0] && md <= F[1]; };
  // "11/12/2026 07:00", "0700 11/18/2026 DH", "11/3/26 7:00 AM" → "2026-11-12"
  const sheetDate = (txt) => { const m = String(txt || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return ""; const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; };
  const health = { reasons: null, compare: null, loading: false };
  function loadHealthExtras() { return (health.loading = health.loading || loadHealthExtras1()); }
  async function loadHealthExtras1() {
    const W = window.PL_ARCHIVE || {};
    const get = async (url) => { try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? csvObjects(await r.text()) : []; } catch (e) { return []; } };
    [health.reasons, health.compare] = await Promise.all([W.reasons || get("decisions/pl_reasons.csv"), W.plCompare || get("data/archive/pl_compare.csv")]);
    refreshHealthBadge();
    if (view === "health") { const s = $("#summary"); if (s) s.innerHTML = SUMMARY.health(); }
  }
  /* Every check: { area, level: "bad" | "warn" | "info" | "ok", title, detail } */
  function healthChecks() {
    const out = [], add = (area, level, title, detail = "") => out.push({ area, level, title, detail });
    const H = state.health || {}, steps = H.steps || {}, now = mtNow(), today = now.slice(0, 10), yday = Review.addDays(today, -1);
    const fs = inFireSeason(today);
    // the scheduled updates themselves
    const last = H.run || state.meta.asOf;
    const lh = hoursSince(last);
    if (lh > 26) add("Updates", "bad", `No update for ${ago(last)}`, "The job runs at 8 AM and 9 PM Mountain. Check the repository's Actions tab: a run may have failed, or GitHub may have skipped it.");
    else if (lh > 14) add("Updates", "warn", `Last update ${ago(last)}`, "One scheduled update seems to have been skipped or delayed; the next one should catch up.");
    else add("Updates", "ok", `Last update ${ago(last)}`, `${fmtDate(last, true)}${H.trigger ? ` (${H.trigger === "schedule" ? "scheduled" : H.trigger === "push" ? "started by an upload" : "started by hand"})` : ""}`);
    for (const [label, st] of Object.entries(steps)) if (!st.ok) add(label.replace(/ \(.*\)$/, ""), "bad", `Failed on the ${fmtDate(st.at, true)} update`, `${st.msg || ""}${st.lastOk ? ` Last worked ${fmtDate(st.lastOk, true)}.` : ""} The site keeps the last good data.`);
    // 7-Day outlook
    const o = state.outlook || {};
    if (!o.startDate) add("7-Day outlook", "bad", "No 7-Day outlook");
    else if (o.startDate < today && now.slice(11) >= "11:00") add("7-Day outlook", "warn", `This morning's 7-Day isn't in (latest issued ${fmtDate(o.startDate)})`, "NPSG may be late, or the pull failed. The forecast covers only the days that outlook still reaches.");
    else add("7-Day outlook", "ok", `7-Day issued ${fmtDate(o.startDate)}`);
    if ((o.missing || []).length) add("7-Day outlook", "warn", `${o.missing.length} PSA-days missing from the 7-Day`, `Set to 1 (little or no risk): ${o.missing.slice(0, 8).join(", ")}${o.missing.length > 8 ? "…" : ""}`);
    // ERC / BI
    const d = state.danger || {};
    if (!d.date) add("ERC / BI", "bad", "No ERC/BI");
    else if (d.date < Review.addDays(yday, -1)) add("ERC / BI", "bad", `ERC/BI is from ${fmtDate(d.date)}`, `It should be yesterday's (${fmtDate(yday)}). ${esc(d.source || "")}`);
    else if (d.date < yday) add("ERC / BI", "warn", `ERC/BI is from ${fmtDate(d.date)}`, `Yesterday's (${fmtDate(yday)}) isn't in yet; FEMS posts each day after midnight.`);
    else add("ERC / BI", "ok", `ERC/BI for ${fmtDate(d.date)}`, esc(d.source || ""));
    if (Array.isArray(d.stations) && d.stations.length) {
      const N = window.PL_NFDRS, reported = new Set(d.stations.filter((x) => x.reported).map((x) => x.id)), total = N ? N.ALL_IDS.length : 40;
      const missing = d.stations.filter((x) => !x.reported);
      if (reported.size < total) add("ERC / BI", reported.size < total - 4 ? "bad" : "warn", `${total - reported.size} of ${total} ERC stations didn't report`, `Left out of their PSA's average: ${[...new Map(missing.map((x) => [x.id, `${x.name} (${x.psa})`])).values()].join(", ")}`);
      const empty = Object.entries(d.rows || {}).filter(([, x]) => x.stations === 0).map(([k]) => k);
      if (empty.length) add("ERC / BI", "bad", `No ERC station reported in ${empty.join(", ")}`, "Those PSAs have no ERCy today.");
    }
    if (/^Uploaded/.test(d.source || "")) add("ERC / BI", "info", "ERC/BI comes from an uploaded file", "A file uploaded for the same day or later wins over the automatic FEMS values.");
    const bpw = (window.PL_NFDRS && window.PL_NFDRS.BREAKPOINTS && window.PL_NFDRS.BREAKPOINTS.warnings) || [];
    if (bpw.length) add("ERC / BI", "warn", "Check the ERC/BI breakpoints file", bpw.join("; "));
    const fd = Object.keys(state.forecastDanger || {});
    if (!fd.length) add("PL forecast", "warn", "No FEMS forecast ERC/BI", "The forecast uses the latest observed ERC/BI for every day.");
    else if (fd.length < 6) add("PL forecast", "info", `FEMS forecast ERC/BI for ${fd.length} of the next 6 days`);
    // Fire activity
    const f = state.fire || {};
    if (f.fetchedAt && hoursSince(f.fetchedAt) > 26) add("Fire activity", "warn", `Fire activity last pulled ${ago(f.fetchedAt)}`);
    if ((f.byAcres || []).length) add("Fire activity", "info", `${f.byAcres.length} fire${f.byAcres.length > 1 ? "s" : ""} counted as Type 3 by size`, `WFIGS has no complexity for them (or still Type 4/5), but they've reached large-fire size: ${f.byAcres.map((i) => `${esc(i.name)} ${Number(i.acres).toLocaleString()} ac (${i.psa})`).join(", ")}. Worth checking with dispatch.`);
    if (f.noComplexity > 0) add("Fire activity", "info", `${f.noComplexity} active fire${f.noComplexity > 1 ? "s have" : " has"} no complexity in WFIGS`, "Small ones are normal; large ones are counted by size (above).");
    const fsData = state.fireStarts || {};
    if (fsData.to && fsData.to < Review.addDays(yday, -1)) add("Fire starts", "warn", `New fire starts only through ${fmtDate(fsData.to)}`);
    // Weather
    const w = state.raws || {};
    if (!w.date) add("Weather", "warn", "No RAWS weather yet");
    else {
      if (w.date < Review.addDays(yday, -1)) add("Weather", "warn", `Weather is from ${fmtDate(w.date)}`);
      if (w.asosError) add("Weather", "warn", "ASOS/AWOS airport stations weren't added", esc(w.asosError));
      const none = Object.entries(w.byPsa || {}).filter(([, x]) => !x.stations).map(([k]) => k);
      if (none.length) add("Weather", "warn", `No weather station reported in ${none.join(", ")}`);
      const dropped = (w.checks || []).filter((c) => c.action === "dropped").length;
      if (dropped > 40) add("Weather", "warn", `${dropped} weather readings removed by the quality checks`, "More than usual: a station or network may be sending bad data. See History & Data → yesterday's checks.");
      const kept = (w.checks || []).filter((c) => /wind event/.test(c.action || "")).length;
      if (kept) add("Weather", "info", `${kept} high gust${kept > 1 ? "s" : ""} kept as real wind events`, "Backed up by nearby stations or the station's own wind; see History & Data.");
    }
    // Crews and IMTs: the pull itself, and how old the SharePoint sheet is (only flagged in fire season)
    const cs = state.crewsSource || {}, is = state.imtsSource || {};
    for (const [area, src] of [["Crews", cs], ["IMTs", is]]) {
      if (!src.fetchedAt) { add(area, "warn", `${area} haven't been pulled from SharePoint yet`); continue; }
      if (hoursSince(src.fetchedAt) > 26) add(area, "bad", `${area} last pulled from SharePoint ${ago(src.fetchedAt)}`, "The SharePoint link may have changed or stopped allowing downloads.");
      const sd = sheetDate(src.lastUpdate);
      if (sd) {
        const days = Math.round(hoursSince(sd) / 24);
        if (fs && days > ((C.health || {}).sheetDaysInSeason || 2)) add(area, "warn", `${area} sheet last updated ${fmtDate(sd)} (${days} days ago)`, "During fire season it's normally updated daily.");
        else add(area, "ok", `${area} sheet last updated ${fmtDate(sd)}`, fs ? "" : "Off season: updated occasionally, so its age isn't flagged.");
      }
    }
    if (cs.fetchedAt && !cs.t2iaSheet) add("Crews", "warn", "The SWA Type 2IA tab wasn't found in the crews workbook");
    // Official PL
    const a = state.actualPl || {}, pc = state.plConfirm;
    if (!a.pl) add("Official PL", "warn", "Couldn't read the official SW PL", "From NICC (nifc.gov/nicc) or the SWCC page; see data/archive/actual_pl_debug.txt in the repository.");
    else if (a.carried) add("Official PL", "info", `NICC isn't listing the GACC PLs today; PL${a.pl} carried forward from ${fmtDate(a.carriedFrom)}`, `Normal in the off season (the NICC table is empty and the SWCC page shows the PL as a picture). If the SW PL changed, add a line for today to <a href="https://github.com/${(C.health || {}).repo || "SWCCFireWx/sw-pl-tool-new"}/edit/main/decisions/pl_reasons.csv" target="_blank" rel="noopener">decisions/pl_reasons.csv</a> with the official PL; it's used as the official PL that day.`);
    else if ((a.date || "") < today && now.slice(11) >= "10:00") add("Official PL", "info", `Official SW PL last read for ${fmtDate(a.date)}`);
    if (pc && pc.pending) add("PL", "info", `PL change waiting: calculated PL${pc.pending.pl}, PL stays PL${pc.pl}`, `Changes when ${Math.max(1, ((C.plConfirm || {}).runsToAgree || 2) - (pc.pending.runs || 0))} more scheduled run(s) agree.`);
    if (health.compare) {
      const have = new Set((health.reasons || []).filter((r) => String(r.reason || "").trim()).map((r) => String(r.date).slice(0, 10)));
      const need = health.compare.filter((r) => r.differs === "yes" && !have.has(r.date));
      const repo = (C.health || {}).repo || "SWCCFireWx/sw-pl-tool-new";
      if (need.length) add("Official PL", "warn", `${need.length} day${need.length > 1 ? "s" : ""} when the official PL differed from the tool, with no reason recorded`,
        `${need.slice(-8).map((r) => `${fmtDate(r.date)}: official PL${r.official_pl}, tool PL${r.tool_pl}`).join("; ")}. <a href="https://github.com/${repo}/edit/main/decisions/pl_reasons.csv" target="_blank" rel="noopener">Add the reason on GitHub</a> (one line per day: date, official PL, tool PL, reason, initials).`);
    }
    // Criteria
    const ch = (state.criteriaChanges || []).slice(-1)[0];
    if (ch && !ch.labelChanged && hoursSince(ch.at) < 24 * 30) add("Criteria", "warn", "The criteria changed but the version label didn't", `On ${fmtDate(ch.at, true)} the settings changed (${ch.fromFingerprint} → ${ch.toFingerprint}) while the label stayed "${esc(ch.to)}". Update criteriaVersion in js/config.js so the archive can tell the two apart.`);
    else if (ch && hoursSince(ch.at) < 24 * 14) add("Criteria", "info", `Criteria changed to "${esc(ch.to)}" on ${fmtDate(ch.at)}`);
    // Archive fill-in
    const bf = H.backfill;
    if (bf && (bf.ercy || bf.weather)) add("Archive", "info", `Still filling in the archive back to ${fmtDate(bf.from)}`, `${bf.ercy ? `${bf.ercy} days of ERC/BI` : ""}${bf.ercy && bf.weather ? " and " : ""}${bf.weather ? `${bf.weather} days of weather (about ${Math.ceil(bf.weather / ((C.autoData.backfill || {}).weatherDaysPerRun || 30))} more runs)` : ""} to go.`);
    const gu = H.backfillGaveUp || {};
    if ((gu.ercy || []).length || (gu.weather || []).length) add("Archive", "warn", "Some past days couldn't be filled in", `FEMS had nothing after 3 tries for: ${[...(gu.ercy || []).map((x) => `${x} ERC/BI`), ...(gu.weather || []).map((x) => `${x} weather`)].slice(0, 12).join(", ")}`);
    return out;
  }
  function refreshHealthBadge() {
    const b = $("#health-badge"); if (!b || !state) return;
    const c = healthChecks(), bad = c.filter((x) => x.level === "bad").length, warn = c.filter((x) => x.level === "warn").length;
    b.hidden = !(bad + warn);
    b.textContent = bad + warn;
    b.dataset.level = bad ? "bad" : "warn";
    b.title = `${bad} problem${bad === 1 ? "" : "s"}, ${warn} to check`;
  }
  VIEW.health = () => `
    ${head("Data Health", "Everything feeding the PL, and anything that isn't working right: failed pulls, old data, stations not reporting, fires counted by size, and days when the official PL differed from the tool. Checked every time the page loads.")}
    <div id="summary"></div>`;
  AFTER.health = [() => { loadHealthExtras(); }];
  SUMMARY.health = () => {
    const c = healthChecks();
    const icon = { bad: "✕", warn: "!", info: "i", ok: "✓" }, word = { bad: "Problem", warn: "Check", info: "Note", ok: "OK" };
    const by = (lv) => c.filter((x) => x.level === lv);
    const item = (x) => `<li class="hc ${x.level}"><span class="hc-i" aria-label="${word[x.level]}">${icon[x.level]}</span><div><b>${esc(x.area)}:</b> ${x.title}${x.detail ? `<div class="small muted">${x.detail}</div>` : ""}</div></li>`;
    const bad = by("bad"), warn = by("warn");
    const head1 = bad.length ? `<p class="hc-sum bad">${bad.length} problem${bad.length > 1 ? "s" : ""} need${bad.length > 1 ? "" : "s"} attention${warn.length ? `, ${warn.length} more to check` : ""}.</p>`
      : warn.length ? `<p class="hc-sum warn">Nothing broken; ${warn.length} thing${warn.length > 1 ? "s" : ""} to check.</p>` : `<p class="hc-sum ok">Everything is working.</p>`;
    return `<section class="panel">${head1}
        ${bad.length || warn.length ? `<ul class="hc-list">${[...bad, ...warn].map(item).join("")}</ul>` : ""}</section>
      ${by("info").length ? `<section class="panel"><h3>Notes</h3><ul class="hc-list">${by("info").map(item).join("")}</ul></section>` : ""}
      <section class="panel"><h3>Working normally</h3><ul class="hc-list">${by("ok").map(item).join("")}</ul>
        <p class="muted small">Each update's full log is on GitHub: the repository's <b>Actions</b> tab → <b>Update PL data</b> → the run. Crew and IMT sheet dates are only flagged during fire season (${((C.health || {}).fireSeason || ["04-01", "09-30"]).map((x) => `${+x.slice(0, 2)}/${+x.slice(3)}`).join("–")}).</p></section>
      ${reasonsTable()}`;
  };
  function reasonsTable() {
    const cmp = (health.compare || []).filter((r) => r.differs === "yes");
    if (!cmp.length && !(health.reasons || []).length) return "";
    const rs = Object.fromEntries((health.reasons || []).map((r) => [String(r.date).slice(0, 10), r]));
    const days = [...new Set([...cmp.map((r) => r.date), ...Object.keys(rs)])].sort().reverse().slice(0, 60);
    return `<section class="panel"><h3>When the official PL differed from the tool</h3>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Official</th><th class="num">Tool</th><th>Reason</th><th>By</th></tr></thead><tbody>
      ${days.map((d) => { const c1 = cmp.find((r) => r.date === d) || {}, r = rs[d] || {}; return `<tr><td>${fmtDate(d)}</td><td class="num">PL${c1.official_pl || r.official_pl || "?"}</td><td class="num">PL${c1.tool_pl || r.tool_pl || "?"}</td><td>${r.reason ? esc(r.reason) : `<span class="warn-t">no reason yet</span>`}</td><td>${esc(r.entered_by || "")}</td></tr>`; }).join("")}
      </tbody></table></div>
      <p class="muted small">Reasons are kept in <code>decisions/pl_reasons.csv</code> in the repository (see decisions/README.md); the scheduled job never changes that file.</p></section>`;
  }

  /* ---------- Calculations (how the PL is worked out, with today's numbers) ---------- */
  VIEW.calc = () => `
    ${head("Calculations", "How the PL is worked out, step by step, with today's numbers. The highlighted row in each table is the one that applies right now.")}
    <div id="summary"></div>`;
  SUMMARY.calc = () => {
    const r = result, f = r.fire, M = C.fireActivityModel, o = r.outlook;
    const on = (b) => (b ? ` class="on"` : "");
    const n1 = (v) => (v === null || v === undefined || v === "" ? "–" : v);
    const section = (title, body) => `<section class="panel calc-sec"><h3>${title}</h3>${body}</section>`;
    const bandRows = (bands, cur, unit) => {
      const all = [{ rating: "Minimum", atLeast: 0 }, ...bands];
      return all.map((b, i) => { const hi = all[i + 1] ? all[i + 1].atLeast : null;
        return `<tr${on(cur === b.rating)}><td>${chip(b.rating)}</td><td>${i === 0 ? `under ${hi}` : hi === null ? `${b.atLeast} or more` : `${b.atLeast} to under ${hi}`} ${unit}</td></tr>`; }).join("");
    };
    // 1. PL score
    const elRows = r.elements.map((e) => `<tr><td>${esc(e.name)}</td><td>${chip(e.rating, false, e.inverted)}</td>
      <td class="num">${fmt2(e.multiplier)}</td><td class="num">× ${fmt2(e.weight)}</td><td class="num">= <b>${fmt3(e.contribution)}</b></td></tr>`).join("");
    const plRows = C.plLevels.map((p, i) => { const nx = C.plLevels[i + 1];
      return `<tr${on(r.scorePl === p.pl)}><td><b>PL${p.pl}</b></td><td>${nx ? `${p.min} to under ${nx.min}` : `${p.min} or more`}</td></tr>`; }).join("");
    const s1 = section("1 · PL score", `
      <p>Each element gets an adjective rating. The rating's multiplier times the element's weight is its contribution, and the contributions add up to the PL score.</p>
      <p class="small"><b>Season weights:</b> ${Object.entries(C.weightPresets).map(([k, p]) => `${k === state.preset ? "<b>" : ""}${esc(p.label)}: ${C.elements.map((e) => `${esc(e.name.replace(/ \(.*\)$/, ""))} ${fmt2(p.weights[e.key])}`).join(", ")}${k === state.preset ? "</b> (in use)" : ""}`).join(" · ")}. The season is switched by hand, only by the SWCCFireWx GitHub account (steps in the README, <i>Switching the season</i>; it's kept in <code>data/season.txt</code>). The new season's PL applies right away, and each run records the season it used.</p>
      <div class="table-wrap"><table><thead><tr><th>Element</th><th>Rating</th><th class="num">Multiplier</th><th class="num">Weight</th><th class="num">Contribution</th></tr></thead>
        <tbody>${elRows}<tr class="total-row"><td colspan="4">PL score</td><td class="num"><b>${fmt3(r.score)}</b></td></tr></tbody></table></div>
      <p class="small muted">Multipliers: Minimum 0 · Low 0.25 · Moderate 0.5 · High 0.75 · Maximum/Extreme 1. IMT and crew availability use the inverted scale (fewer available = higher); they carry weight only in fire season. Teams and crews busy in the Southwest also add a step to Fire Activity (step 2d).</p>
      <div class="grid-2"><div class="table-wrap"><table><thead><tr><th>PL</th><th>Score</th></tr></thead><tbody>${plRows}</tbody></table></div>
      <div><h4>PL3 and above need fire on the ground</h4>
        <p>If Fire Activity is Minimum, the PL is held at PL${C.plGate.maxPlWithoutFire} however high the 7-Day and ERCy are.</p>
        <p class="calc-result">Score ${fmt3(r.score)} → PL${r.scorePl}; Fire Activity ${chip(f.rating)} → ${r.held ? `<b>held at PL${r.pl}</b>` : `no hold`} → <b>PL${r.pl}</b></p></div></div>
      <h4>When the PL changes</h4>
      <p class="small">The PL only moves to a new level when <b>two scheduled updates in a row</b> (8 AM and 9 PM Mountain) calculate it, so one odd update can't move it. Updates started by hand or by an upload are shown but don't count. ${(() => { const c = state.plConfirm; return c && c.pl ? (c.pending ? `Today: calculated PL${c.pending.pl}, the PL stays <b>PL${c.pl}</b> until the next scheduled update agrees.` : `Today: <b>PL${c.pl}</b>, unchanged since ${fmtDate(c.since, true)}.`) : ""; })()}</p>`);

    // 2. Fire Activity
    const lgRows = C.fireActivity.map((g) => `<tr${on(f.large === g.rating)}><td>${chip(g.rating)}</td><td>${g.maxIncidents === 0 ? "no T3+ incidents" : Number.isFinite(g.maxIncidents) ? `up to ${g.maxIncidents} T3+ incidents, no more than ${g.maxComplex} T2/complex` : "more than that"}</td></tr>`).join("");
    const cap = M.capacity, im = r.imt, cr = r.crews;
    const capHit = f.steps.some((x) => x.kind === "capacity"), outHit = f.steps.some((x) => x.kind === "outlook");
    const front = o.daily.length === 7 ? (o.daily[0].score + o.daily[1].score + o.daily[2].score) / 3 : NaN;
    const back = o.daily.length === 7 ? (o.daily[3].score + o.daily[4].score + o.daily[5].score + o.daily[6].score) / 4 : NaN;
    const highDays = o.daily.reduce((a, d) => a + d.counts[4], 0);
    const s2 = section("2 · Fire Activity: how many resources we need and how hard they're working", `
      <div class="grid-2">
        <div><h4>a. Large fires</h4><p class="small">Active, uncontained T3+ incidents in the SW PSAs (WFIGS). When WFIGS has no complexity for a fire (or still lists it as Type 4/5), it counts as a Type 3 once it reaches NWCG large-fire size: ${(C.autoData.fireActivity || {}).largeFireAcresTimber || 100} acres in timber, ${(C.autoData.fireActivity || {}).largeFireAcresOther || 300} acres in grass/brush or when the fuel isn't given. Today: <b>${f.complex}</b> T2/complex, <b>${f.t3}</b> T3${(state.fire.byAcres || []).length ? ` (${state.fire.byAcres.length} counted by size: ${state.fire.byAcres.map((x) => esc(x.name)).join(", ")})` : ""}.</p>
          <div class="table-wrap"><table><tbody>${lgRows}</tbody></table></div></div>
        <div><h4>b. Initial attack</h4><p class="small">The higher of new starts per day (3-day average) and escapes. Today: <b>${n1(f.startsAvg)}</b> starts/day → ${chip(f.startsRating)}, <b>${n1(f.escapes)}</b> escapes → ${chip(f.escapeRating)}.</p>
          <div class="grid-2 tight"><div class="table-wrap"><table><thead><tr><th colspan="2">Starts per day</th></tr></thead><tbody>${bandRows(M.startsPerDay, f.startsRating, "a day")}</tbody></table></div>
          <div class="table-wrap"><table><thead><tr><th colspan="2">Escapes</th></tr></thead><tbody>${bandRows(M.escapes, f.escapeRating, "")}</tbody></table></div></div>
          <p class="small muted">An escape is a fire found in the last 3 days that is still uncontained and is 100+ acres or T3 and up.</p></div>
      </div>
      <p class="calc-result">c. Demand = higher of large fires ${chip(f.large)} and initial attack ${chip(f.ia)} = ${chip(f.demand)}</p>
      <div class="grid-2">
        <div${capHit ? ` class="hit"` : ""}><h4>d. Resources busy in the Southwest: +1 step</h4>
          <p class="small">When ${cap.minCimtCommittedInSw}+ CIMTs or ${cap.minT3CommittedInSw}+ Type 3 teams are on Southwest incidents, or ${Math.round(cap.minCrewShareCommittedInSw * 100)}%+ of the crews in the Southwest are committed there (crews out of area are left out of the count: 20 crews with 5 out of area means 15 in the Southwest). Teams and crews out of area, off rotation or unavailable for the season don't count, so they never raise the PL.</p>
          <p class="small">Today: ${im.commCimtSw} CIMT${im.commCimtSw === 1 ? "" : "s"} and ${im.commT3Sw} Type 3 team${im.commT3Sw === 1 ? "" : "s"} on Southwest incidents${im.commOut ? ` (${im.commOut} out of area, not counted)` : ""}; ${cr.committedSw} of the ${cr.pool} crews in the Southwest committed (${Math.round(cr.committedSwShare * 100)}%)${cr.committedOut ? `; ${cr.committedOut} out of area, left out of the count` : ""} → <b>${capHit ? "+1" : f.demand === "Minimum" && (im.commCimtSw >= cap.minCimtCommittedInSw || im.commT3Sw >= cap.minT3CommittedInSw || cr.committedSwShare >= cap.minCrewShareCommittedInSw) ? "would add +1, but no fire on the ground" : "no step"}</b></p></div>
        <div${outHit ? ` class="hit"` : ""}><h4>e. 7-Day rising: +1 step</h4>
          <p class="small">When the 7-Day rating is already High/Maximum, or days 4–7 average ${M.outlook.risingBy}+ points above days 1–3 with ${M.outlook.minHighRiskPsaDays}+ high-risk PSA-days in the week.</p>
          <p class="small">Today: rating ${chip(o.rating)}; days 1–3 average ${Number.isFinite(front) ? front.toFixed(1) : "–"}, days 4–7 ${Number.isFinite(back) ? back.toFixed(1) : "–"}; ${highDays} high-risk PSA-days → <b>${outHit ? "+1" : "no step"}</b></p></div>
      </div>
      <p class="calc-result">Fire Activity = demand ${chip(f.demand)} ${f.steps.map(() => "+ 1").join(" ")} = ${chip(f.computed)}${f.mode === "override" ? ` · set by hand to ${chip(f.rating)}` : ""}</p>
      <p class="small muted">Steps d and e only apply when there is fire on the ground (demand above Minimum), and the result stops at Maximum. All thresholds are starting values in <code>fireActivityModel</code> in js/config.js, to be tuned against the archive.</p>`);
    // 3. Fire potential
    const out = C.outlook || {};
    const s3 = section("3 · 7-Day Fire Potential Trend and PSA ERCy", `
      <div class="grid-2">
        <div><h4>7-Day trend</h4><p class="small">Each day's score is the sum of the 15 PSA levels (1–4, so 15–60). The 7-day average sets the rating: under 25 Minimum, under 37 Low, under 46 Moderate, under 52 High, otherwise Maximum.</p>
          <p class="calc-result">Daily scores ${o.daily.map((d) => d.score).join(", ")} → average ${o.avg.toFixed(2)} → ${chip(o.rating)}</p></div>
        <div><h4>PSA ERCy</h4><p class="small">From yesterday's FEMS daily summary (fuel model Y, each station's daily maximum) for the 40 SWCC stations, worked out like the NFDRSy processing workbook: each station's ERC rounded to one decimal; a PSA's ERCy = its stations' ERC added up, rounded up to a whole number, divided by the stations that reported, to one decimal (a station that didn't report is left out). BI is the plain average, to one decimal. The percentile comes from the ERC/BI BREAK POINTS (data/erc_bi_breakpoints.csv, shown on the PSA ERCy page): ERCy 97 / 90 / 85 / 75 / 50, otherwise 45. Then: 8+ PSAs at the 97th percentile or above → Extreme; any at 97+ → High; any 90–96 → Moderate; any 50–89 → Low; otherwise Minimum.</p>
          <p class="calc-result">97+: ${r.danger.bins.p97plus} · 90–96: ${r.danger.bins.p90to96} · 50–89: ${r.danger.bins.p50to89} · under 50: ${r.danger.bins.below50} → ${chip(r.danger.rating)}</p></div>
      </div>
      <div class="grid-2">
        <div><h4>IMT availability</h4><p class="small">CIMTs available: 0 Minimum, 1–2 Low, 3 Moderate, 4+ High, Maximum if 4+ Type 3 teams are also available. Weight: shoulder season 0, fire season ${fmt2(C.weightPresets.season.weights.imt)}. Teams committed out of area are left out of the count and the available teams scaled to the full roster (4 CIMTs, 2 out of area, 1 of the other 2 available → rated as 2 available), so teams out of area never raise the PL. Teams on Southwest incidents also count in step 2d. A committed team is in the Southwest when its incident dispatch/GACC is a Southwest center or SWCC, or its incident state is AZ or NM. Today ${im.availCimt} CIMTs, ${im.availT3} Type 3 available${im.commOutCimt || im.commOutT3 ? ` (rated as ${im.ratedCimt} CIMTs, ${im.ratedT3} Type 3 with ${im.commOutCimt + im.commOutT3} out of area left out)` : ""} → ${chip(im.rating, false, true)}; ${im.commCimtSw + im.commT3Sw} committed in the Southwest, ${im.commOut} out of area.</p></div>
        <div><h4>Crew availability</h4><p class="small">(Available + prepositioned at SWCC) ÷ crews in the Southwest: SWA crews (plus Type 2IA crews if they're switched on) minus those committed out of area (C-O). 20 crews with 5 out of area means 15 in the Southwest. Weight: shoulder season 0, fire season ${fmt2(C.weightPresets.season.weights.crews)}. Crews on Southwest incidents also count in step 2d. Today ${cr.totalAvail} ÷ ${cr.pool} = ${Math.round(cr.ratio * 100)}% → ${chip(cr.rating, false, true)}${cr.committedOut ? ` (${cr.committedOut} out of area left out)` : ""}. SWA Type 2IA crews: ${cr.includeT2IA ? "counted" : "not counted"} (<code>crewAvailability.includeT2IA</code>).</p></div>
      </div>`);
    // 4. Old vs new
    const keys = ["shoulder", "season"];
    const res = { shoulder: calc.oldMethod(state, "shoulder"), season: calc.oldMethod(state, "season") };
    const s4 = section("4 · Compared with the old spreadsheet method", `
      <div class="table-wrap"><table><thead><tr><th>Method</th>${C.elements.map((e) => `<th class="num">${esc(e.name.replace(/ \(.*\)$/, ""))}</th>`).join("")}<th class="num">Today</th></tr></thead><tbody>
        <tr${on(true)}><td>This tool (${esc(presetLabel())})</td>${C.elements.map((e) => `<td class="num">${fmt2(r.weights[e.key])}</td>`).join("")}<td class="num"><b>PL${r.pl}</b> (${fmt3(r.score)})</td></tr>
        ${keys.map((k) => `<tr><td>Old method, ${esc(C.weightPresets[k].label)}</td>${C.elements.map((e) => `<td class="num">${fmt2(C.weightPresets[k].weights[e.key])}</td>`).join("")}<td class="num"><b>PL${res[k].pl}</b> (${fmt3(res[k].score)})</td></tr>`).join("")}
      </tbody></table></div>
      <p class="small muted">The old method used only the large-fire count for Fire Activity, had no PL2 hold, and counted teams and crews out of area as unavailable. Every run saves both results in history.csv (<code>pl</code>, <code>old_shoulder_pl</code>, <code>old_season_pl</code>) so the two can be compared over a season.</p>`);
    // 5. Weather checks
    const s5 = section("5 · Weather data checks (RAWS + ASOS/AWOS)", `
      <p class="small">Weather is recorded in the archive to test the PL against, not used in the score. Every RAWS (FEMS) and ASOS/AWOS (Iowa Environmental Mesonet) station in a PSA is checked hour by hour before it's summarized:</p>
      <ul class="small calc-list">
        <li>Readings outside physical limits (temperature −40 to 125 °F, RH 1–100%, wind 0–80 mph, gust over 130 mph, 2+ in. of rain in one hour), FEMS "suspicious" flags, sensors stuck on one value 12+ hours, and one-hour spikes are removed.</li>
        <li>A gust that looks odd (over 75 mph, far above the sustained wind, a 40 mph jump from the hours either side, or far above every other station in the PSA) is kept only when something backs it up <b>at a similar strength</b>:
          up to 75 mph, the station's own sustained wind is 40% of the gust, the hour before or after gusted 70% of it, an outflow signature (temperature drop 10 °F, RH jump 15, rain), or another station in the PSA gusted 60% of it within 2 hours;
          75–90 mph, the same without the outflow signature; over 90 mph, only another station gusting half of it (45+ mph) counts.</li>
        <li>A PSA has a wind event only when 2+ stations (or a quarter of them) still have gusts of 40+ mph after the checks.</li>
        <li>Example: Nov 15, The Bowl (SW-12) reported 125 mph. The nearest backing was 43 mph at Pinery, short of the 63 needed, so it's removed.</li>
      </ul>`);
    // 6. Forecast
    const fcd = calc.forecast(state, { today: todayIso() });
    const s6 = section("6 · PL forecast (Day 1 = today to Day 7)", `
      <p class="small">On the PL Outcome page. Lined up with the 7-Day Fire Potential Outlook issued that morning: Day 1 is today, Day 2 tomorrow … Day 7 six days out. Each day is worked out with the same calculation as today's PL:</p>
      <ul class="small calc-list">
        <li><b>Fire potential:</b> the outlook from that day to Day 7 (Day 1 uses Days 1–7, Day 2 uses Days 2–7 … Day 7 uses Day 7 only), so Day 1 is today's PL.</li>
        <li><b>Fire danger:</b> the FEMS forecast ERC/BI for that day for the same 40 stations, worked out like the observed values; the latest observed values if FEMS has none.</li>
        <li><b>Fire workload:</b> today's fires, crews and IMTs held steady (they can't be forecast), with the +1 steps checked again for each day.</li>
        <li>Every forecast is archived and checked against the official PL (Season Review → Forecast vs actual PL).</li>
      </ul>
      ${fcd.length ? "" : `<p class="small muted">No forecast yet: it needs this morning's 7-Day.</p>`}<p class="calc-result"${fcd.length ? "" : " hidden"}>${fcd.map((d) => `Day ${d.outlookDay} ${fmtDate(d.date).replace(/, \d{4}$/, "")}: PL${d.pl}`).join(" · ")}</p>`);
    // 7. The official PL, the reasons, the criteria version
    const cv = state.criteria || calc.criteriaVersion();
    const s7 = section("7 · Official PL, reasons and criteria version", `
      <ul class="small calc-list">
        <li><b>Official SW PL:</b> read every update from NICC (nifc.gov/nicc, the Geographic Area table), or the SWCC page if NICC can't be read. An official PL typed into <code>decisions/pl_reasons.csv</code> for today wins. When NICC's table is empty (off season), the last official PL carries forward. ${state.actualPl && state.actualPl.pl ? `Today: PL${state.actualPl.pl} (${esc(state.actualPl.source)}).` : ""}</li>
        <li><b>When it differs from this tool</b>, the day is listed on the Data Health tab with a link to add the reason in <code>decisions/pl_reasons.csv</code>. The reasons show on Data Health, the History calendar and Season Review.</li>
        <li><b>Criteria version:</b> every update records the label in <code>js/config.js</code> (now "${esc(cv.label || "")}") and a fingerprint of every setting that can change the PL (${esc(cv.fingerprint || "")}), including the breakpoints. A change without a new label is flagged on Data Health.</li>
        <li><b>Data checks:</b> the Data Health tab lists anything that isn't working: failed or missed updates, late 7-Day or ERC/BI, stations not reporting, fires counted by size, crews/IMTs not pulled (sheet dates only flagged April–September), and archive fill-in progress.</li>
      </ul>`);
    // 8. How to
    const repo = (C.health || {}).repo || "SWCCFireWx/sw-pl-tool-new";
    const s8 = section("8 · How to", `
      <ul class="small calc-list">
        <li><b>Update the data now:</b> on GitHub, Actions → Update PL data → Run workflow. (It also runs by itself at 8 AM and 9 PM Mountain.)</li>
        <li><b>Re-pull past days</b> (ERC/BI and weather): Run workflow with a date in <i>backfill_from</i>. The archive also fills itself in back to Jan 1, 2026, a month of weather per update.</li>
        <li><b>Use an ERC/BI file instead of FEMS:</b> upload it (or the NFDRSy workbook) to the repository's <code>uploads</code> folder.</li>
        <li><b>Change the ERC/BI breakpoints:</b> edit <a href="https://github.com/${repo}/edit/main/data/erc_bi_breakpoints.csv" target="_blank" rel="noopener">data/erc_bi_breakpoints.csv</a>, or upload the NFDRSy workbook with its updated BREAK POINTS tabs to <code>uploads</code>.</li>
        <li><b>Record why the official PL differed:</b> add a line to <a href="https://github.com/${repo}/edit/main/decisions/pl_reasons.csv" target="_blank" rel="noopener">decisions/pl_reasons.csv</a> (date, official PL, tool PL, reason, initials).</li>
        <li><b>Change weights or thresholds:</b> try them first in Season Review → Try different criteria, then edit <code>js/config.js</code> and change <code>criteriaVersion.label</code>.</li>
        <li><b>Count SWA Type 2IA crews in the PL:</b> set <code>crewAvailability.includeT2IA</code> to true in <code>js/config.js</code>; the Crews page switch only changes your own view.</li>
        <li><b>Look up any past day</b> (weather, ERC/BI, fires, PL, crews, IMTs): History &amp; Data → Look up a day.</li>
        <li><b>Switch between shoulder season and fire season for everyone:</b> SWCCFireWx account only; the steps are in the README (<i>Switching the season</i>). Anyone else's switch is ignored or put back.</li>
        <li><b>Try "what if" on the site:</b> anyone can change the Fire Activity tab (counts or rating) and the Model &amp; Data tab (season or custom weights). The changes stay in that browser only, a bar at the top shows the published PL next to yours, and <i>Clear my changes</i> goes back. Fire Activity changes end at the next scheduled run. Add <code>?edit</code> to the address to unlock every tab, also in that browser only.</li>
        <li><b>Who can change the data:</b> GitHub → Settings → Collaborators; only people with Write access can upload or edit.</li>
        <li><b>Something looks wrong:</b> check the Data Health tab, then the update's log on GitHub (Actions → Update PL data → the run).</li>
      </ul>`);
    return s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8;
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
    if (el.id && /^rv-(range|from|to|method)$/.test(el.id)) { if (e.type === "change") onReviewInput(el); return; }
    if (el.id && el.id.startsWith("rv-")) return; // trial inputs: applied with the button
    if (el.id === "cal-date") { if (e.type !== "change" || !el.value) return; cal.date = el.value; const b = $('[data-act="cal-dl"]'); if (b) b.disabled = false; showDay(cal.date); return; }
    if (el.id === "t2ia-toggle") { if (e.type !== "change") return; state.includeT2IA = el.checked; if (EDIT) save(); renderView(); return; }
    if (el.id === "hist-group") { archive.groupBy = el.value; const s = $("#summary"); if (s) s.innerHTML = SUMMARY.history(); return; }
    if (el.dataset.path) {
      if (el.type === "radio" && !el.checked) return;
      let v = el.value;
      if (el.dataset.num !== undefined) v = v === "" ? "" : parseFloat(v);
      const prevPreset = state.preset;
      setPath(el.dataset.path, v);
      if (el.dataset.path.startsWith("fire.") && el.dataset.path !== "fire.updated") {
        stamp("fire");
        if (/\(auto\)/.test(state.fire.source || "")) state.fire.source = state.fire.source.replace("(auto)", "(changed by hand)");
      }
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
      "fire-auto": () => { delete state.fire.override; stamp("fire"); save(); renderView(); },
      "mine-clear": () => clearMine(),
      "copy-brief": () => copyText(briefText(), $("#f-brief")),
      "cal-dl": () => cal.date && downloadDay(cal.date),
      "all-runs": () => { archive.allRuns = !archive.allRuns; const sm = $("#summary"); if (sm) sm.innerHTML = SUMMARY.history(); },
      "rv-apply": () => { rv.trial = readTrial(); rerenderReview(); toast("Trial criteria applied to every archived run"); },
      "rv-clear": () => { rv.trial = null; rerenderReview(); },
      "rv-xlsx": exportReview,
      "rv-copy": () => copyText(trialSnippet(), $("#rv-snippet")),
      "print": printBriefing,
      "xlsx": exportXlsx,
      "email": emailDraft,
      "add-imt": () => { state.imts.push({ mob: "SW", type: "CIMT", zone: "", ic: "", home: "", status: "AN", incident: "", dateComm: "", remarks: "" }); save(); renderView(); },
      "add-crew": () => { state[b.dataset.list].push({ name: "", type: "CRW1", state: "", disp: "", unit: "", dayOff: "", status: "A", location: "", incident: "", dateCom: "", remarks: "" }); stamp(b.dataset.list); save(); renderView(); },
      "del-row": () => { state[b.dataset.list].splice(+b.dataset.idx, 1); stamp(b.dataset.list); save(); renderView(); },
      "bulk-ask": () => { const s = $("#bulk-status").value; $("#bulk-confirm").innerHTML = `<div class="confirm">Set all ${state.crews.length} SWA crews to <b>${esc(s)}</b>? <button class="btn danger" data-act="bulk-do" data-s="${esc(s)}">Set all</button><button class="btn" data-act="cancel">Cancel</button></div>`; },
      "bulk-do": () => { state.crews.forEach((c) => (c.status = b.dataset.s)); stamp("crews"); save(); renderView(); toast(`All SWA crews set to ${b.dataset.s}`); },
      "cancel": () => { b.closest(".confirm").remove(); },
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
