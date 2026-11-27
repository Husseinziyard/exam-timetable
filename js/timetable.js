// =====================================================================
// Overview page (list of timetables + Generate button) and the
// complete timetable map with the health check.
// =====================================================================
import { supabase } from "./config.js";
import { toast } from "./crud.js";
import { validate, timeLabel, SESSION_START } from "./engine.js";
import { openGenerateDialog, studentsFor } from "./generate.js";
import { mountEditor } from "./edit.js";
import { mountAI } from "./ai.js";
import { mountScale } from "./scale.js";
import { availabilityMap, preferenceMap } from "./generate.js";
import { DEFAULT_WEEKLY_LIMITS } from "./engine.js";
import { workingDays } from "./engine.js";
import { withRepeats } from "./repeats.js";
import { examLinks, loadPeriod, pdfFacultySheet, pdfBatches, pdfAllStaff, timetableBatches } from "./viewer.js";
import { findDraftCopy, copyPeriod, deletePeriod, confirmDelete } from "./versions.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (s, opts = { weekday: "short", day: "2-digit", month: "short" }) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
const GRADE_ORDER = ["PROF", "SL1", "SL2", "LECT", "INSTR", "MIL", "HA"];
const GRADE_NAMES = { PROF: "Professor", SL1: "SL Gr. I", SL2: "SL Gr. II", LECT: "Lecturer", INSTR: "Instructor", MIL: "Military", HA: "Hall attendant" };
const ROLE_NAMES = { SUPERVISOR: "Supervisor", INVIGILATOR: "Invigilator", ATTENDANT: "Hall attendant" };

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// =====================================================================
// OVERVIEW
// =====================================================================
export async function renderOverview(root, go) {
  root.innerHTML = `
    <h1 class="page-title">Exam timetable</h1>
    <p class="page-sub">Keep the data up to date, then generate the timetable.</p>
    <div class="generate-card">
      <div>
        <h2>Generate timetable</h2>
        <p>Pick the exam period and what to include. The system plans dates, halls, supervisors, invigilators and hall attendants.</p>
      </div>
      <button class="btn big" id="generate">Generate timetable</button>
    </div>
    <h2 class="sub-head">Timetables</h2>
    <div class="periods"><p class="loading">Loading…</p></div>
    <h2 class="sub-head">Data at a glance</h2>
    <div class="stats"><p class="loading">Counting…</p></div>`;

  root.querySelector("#generate").addEventListener("click", () =>
    openGenerateDialog((id) => go(`timetable/${id}`)));

  // list of timetables
  const periods = await q(supabase.from("exam_periods").select("*").order("created_at", { ascending: false })).catch((e) => { toast(e.message, "error"); return []; });
  const box = root.querySelector(".periods");
  box.innerHTML = periods.length ? `
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Name</th><th>Exam days</th><th>Status</th><th>Created</th><th class="actions-col"></th></tr></thead>
      <tbody>${periods.map((p) => {
        const isCopy = p.status === "draft" && p.options?.replaces;
        const hasCopy = p.status === "published" && periods.some((x) => x.status === "draft" && Number(x.options?.replaces) === p.id);
        return `
        <tr data-id="${p.id}" tabindex="0" title="Open this timetable">
          <td><b>${esc(p.name)}</b></td>
          <td>${fmtDate(p.start_date)} – ${fmtDate(p.end_date, { day: "2-digit", month: "short", year: "numeric" })}</td>
          <td>${p.status === "published" ? '<span class="badge active">Published</span>' : '<span class="badge draft">Draft</span>'}
            ${isCopy ? '<span class="small muted">· changes to the published version</span>' : ""}
            ${hasCopy ? '<span class="small muted">· changes in progress</span>' : ""}</td>
          <td class="muted">${new Date(p.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</td>
          <td class="actions"><button class="link" data-open>Open</button><button class="link danger" data-del>Delete</button></td>
        </tr>`; }).join("")}</tbody></table></div>`
    : `<div class="empty table-wrap"><p><strong>No timetables yet.</strong></p><p class="muted">Click “Generate timetable” to make the first one.</p></div>`;
  box.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    if (e.target.closest("[data-del]")) {
      const per = periods.find((x) => x.id === Number(tr.dataset.id));
      if (!confirmDelete(per)) return;
      try { await deletePeriod(per.id); } catch (err) { return toast(err.message, "error"); }
      toast(per.status === "published" ? "Published timetable deleted." : "Draft deleted.");
      return renderOverview(root, go);
    }
    go(`timetable/${tr.dataset.id}`);
  });
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("tr[data-id]")) e.target.click(); });

  // counts
  const items = [["lecturers", "lecturers", "Staff"], ["rooms", "rooms", "Classes"], ["modules", "modules", "Modules"],
    ["batches", "batches", "Batches"], ["holidays", "holidays", "Holidays"], ["departments", "departments", "Departments"]];
  const counts = await Promise.all(items.map(async ([, t]) => {
    const all = await supabase.from(t).select("*", { count: "exact", head: true });
    const held = t === "holidays" ? { count: 0 } : await supabase.from(t).select("*", { count: "exact", head: true }).eq("on_hold", true);
    return { all: all.count ?? 0, held: held.count ?? 0 };
  }));
  root.querySelector(".stats").innerHTML = items.map(([k, , label], i) => `
    <button class="stat" data-go="${k}">
      <span class="num">${counts[i].all}</span><span class="lab">${label}</span>
      ${counts[i].held ? `<span class="held-note">${counts[i].held} on hold</span>` : ""}
    </button>`).join("");
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
}

// Sidebars sit just below the top bar and just right of the menu, whatever their sizes
let observing = false;
function syncDrawerPosition() {
  const set = () => {
    const top = document.querySelector(".topbar")?.offsetHeight || 72;
    const side = document.querySelector(".sidebar")?.offsetWidth || 0;
    document.documentElement.style.setProperty("--top", `${top}px`);
    document.documentElement.style.setProperty("--side-w", `${side}px`);
  };
  set();
  if (!observing && window.ResizeObserver) {
    observing = true;
    const ro = new ResizeObserver(set);
    document.querySelectorAll(".topbar, .sidebar").forEach((el) => ro.observe(el));
    window.addEventListener("resize", set);
  }
}

// =====================================================================
// LOAD one timetable with everything needed to show it
// =====================================================================
export async function loadTimetable(periodId) {
  const period = await q(supabase.from("exam_periods").select("*").eq("id", periodId).single());
  const [exams, halls, modules, batches, rooms, staff, leave, settings, availability, responses] = await Promise.all([
    q(supabase.from("exams").select("*").eq("period_id", periodId)),
    q(supabase.from("hall_sessions").select("*").eq("period_id", periodId)),
    q(supabase.from("modules").select("*")),
    q(supabase.from("batches").select("*")),
    q(supabase.from("rooms").select("*")),
    q(supabase.from("lecturers").select("*")).then((rows) => rows.filter((s) => s.grade !== "REG")),   // registrar office: never on duty
    q(supabase.from("lecturer_leave").select("*")),
    q(supabase.from("settings").select("*")),
    q(supabase.from("availability").select("lecturer_id,unavailable_date,session").gte("unavailable_date", period.start_date).lte("unavailable_date", period.end_date)),
    q(supabase.from("availability_responses").select("lecturer_id,preference,submitted_at")),
  ]);
  const limits = { ...DEFAULT_WEEKLY_LIMITS, ...(settings.find((s) => s.key === "weekly_limits")?.value || {}) };
  const unavailBy = availabilityMap(availability), prefBy = preferenceMap(responses);
  const links = await examLinks(exams);
  const hallIds = halls.map((h) => h.id);
  const [examHalls, duties] = hallIds.length ? await Promise.all([
    q(supabase.from("exam_halls").select("*").in("hall_session_id", hallIds)),
    q(supabase.from("duties").select("*").in("hall_session_id", hallIds)),
  ]) : [[], []];

  // repeat counts entered for this timetable override the Modules list
  const moduleById = Object.fromEntries(withRepeats(modules, period.options?.repeats).map((m) => [m.id, m]));
  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));
  const roomById = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  const batchesOf = {};
  links.forEach((l) => (batchesOf[l.module_id] ||= []).push(l.batch_id));
  const leaveBy = {};
  leave.forEach((l) => (leaveBy[l.lecturer_id] ||= []).push([l.start_date, l.end_date]));
  const examById = Object.fromEntries(exams.map((e) => [e.id, e]));
  const threshold = Number(period.options?.threshold ?? settings.find((s) => s.key === "second_invigilator_above")?.value ?? 55);

  const hallList = halls.map((h) => ({
    id: h.id, date: h.exam_date, session: h.session, roomId: h.room_id, locked: h.locked,
    roomName: roomById[h.room_id]?.name ?? "?", cap: roomById[h.room_id]?.exam_capacity ?? 0,
    exams: examHalls.filter((x) => x.hall_session_id === h.id).map((x) => ({ id: x.id, examId: x.exam_id, seats: x.seats_used })),
    duties: duties.filter((d) => d.hall_session_id === h.id).map((d) => ({ id: d.id, staffId: d.lecturer_id, role: d.role, locked: d.locked })),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || a.roomName.localeCompare(b.roomName, undefined, { numeric: true }));

  const examList = exams.map((e) => ({ id: e.id, moduleId: e.module_id, date: e.exam_date, session: e.session, locked: e.locked }));
  const staffLite = staff.map((s) => ({
    id: s.id, name: `${s.title ? s.title + " " : ""}${s.full_name}`, grade: s.grade,
    canSup: s.can_supervise, onHold: s.on_hold, leave: leaveBy[s.id] || [],
    unavail: unavailBy[s.id] || {}, pref: prefBy[s.id] || null, cap: limits[s.grade] ?? null,
  }));
  const batchLite = Object.fromEntries(batches.map((b) => [b.id, {
    label: `Intake ${b.intake} · ${b.stream || b.degree}`, onePerDay: false,
  }]));
  return {
    period, exams: examList, halls: hallList, limits, moduleById, batchById, roomById, staffById, batchesOf, examById, threshold,
    staffLite, batchLite,
    moduleStudents: Object.fromEntries(exams.map((e) => [e.module_id, studentsFor(moduleById[e.module_id] || {}, batchesOf, batchById)])),
  };
}

// =====================================================================
// THE TIMETABLE PAGE
// =====================================================================
export async function renderTimetable(root, periodId, go, view = "streams", ui = {}) {
  const scrollY = root.scrollTop;
  if (!ui.keep) root.innerHTML = `<p class="loading">Loading timetable…</p>`;
  let T;
  try { T = await loadTimetable(periodId); }
  catch (err) { root.innerHTML = `<p class="msg show error">${esc(err.message)}</p>`; return; }

  // one-exam-per-day comes from the department
  const depts = await q(supabase.from("departments").select("id,one_exam_per_day"));
  const strict = new Set(depts.filter((d) => d.one_exam_per_day).map((d) => d.id));
  for (const id in T.batchLite) T.batchLite[id].onePerDay = strict.has(T.batchById[id]?.department_id);

  const holidays = await q(supabase.from("holidays").select("holiday_date"));
  T.days = workingDays(T.period.start_date, T.period.end_date, holidays.map((h) => h.holiday_date));
  const checks = T.checks = validate({
    exams: T.exams, halls: T.halls, moduleBatches: T.batchesOf, moduleStudents: T.moduleStudents,
    moduleCode: Object.fromEntries(Object.values(T.moduleById).map((m) => [m.id, m.code])),
    batches: T.batchLite, staff: T.staffLite, threshold: T.threshold,
    slotGroup: Object.fromEntries(Object.values(T.moduleById).filter((m) => m.slot_group).map((m) => [m.id, m.slot_group])),
  });
  const n = (lvl) => checks.filter((c) => c.level === lvl).length;
  // the Load scale opens by itself only when someone is over their weekly limit
  const overLimit = checks.some((c) => /sessions in the week of/.test(c.text || c.message || c.msg || ""));
  const right = ui.right === undefined ? (overLimit && !matchMedia("(max-width: 1100px)").matches ? "scale" : null) : ui.right;   // phones and tablets: never pop open by itself
  const p = T.period;
  const live = p.status === "published";
  if (live) ui.edit = false;                       // the live version is never edited directly
  if (sessionStorage.getItem("openEdit") === String(periodId)) { sessionStorage.removeItem("openEdit"); ui.edit = true; }
  const pendingCopy = live ? await findDraftCopy(p.id).catch(() => null) : null;
  const original = !live && p.options?.replaces
    ? (await supabase.from("exam_periods").select("id,name,status").eq("id", p.options.replaces).maybeSingle()).data : null;
  const staffName = (id) => T.staffLite.find((s) => s.id === id)?.name ?? "?";
  const mod = (id) => T.moduleById[id] || { code: "?", name: "?" };
  const streamsOf = (moduleId) => (T.batchesOf[moduleId] || []).map((b) => T.batchById[b]).filter(Boolean);
  const hallsOfExam = (examId) => T.halls.filter((h) => h.exams.some((x) => x.examId === examId));

  root.innerHTML = `
    <div class="tt-head">
      <div class="tt-top">
        <a class="back-link" href="#overview">← All timetables</a>
        <div class="tt-actions">
          <button class="btn light" id="download" title="Download PDFs or print"><i class="ti ti-download"></i> Download</button>
          ${live ? `<button class="btn light" id="edit-copy"><i class="ti ti-pencil"></i> ${pendingCopy ? "Continue editing" : "Edit"}</button>`
            : `<button class="btn light toggle ${ui.edit ? "on" : ""}" id="edit-toggle" aria-pressed="${!!ui.edit}"><i class="ti ti-pencil"></i> Edit</button>`}
          <button class="btn light toggle ${right === "scale" ? "on" : ""}" id="scale-toggle" aria-pressed="${right === "scale"}" title="Load scale"><i class="ti ti-chart-bar"></i> Load</button>
          <button class="btn light toggle ${right === "ai" ? "on" : ""}" id="ai-toggle" aria-pressed="${right === "ai"}" title="AI assistant"><i class="ti ti-sparkles"></i> AI</button>
          ${live ? "" : `<button class="btn" id="publish"><i class="ti ti-send"></i> ${original ? "Republish…" : "Publish…"}</button>`}
        </div>
      </div>
      <div>
        <h1 class="page-title">${esc(p.name)}</h1>
        <p class="page-sub">${fmtDate(p.start_date, { day: "numeric", month: "long" })} – ${fmtDate(p.end_date, { day: "numeric", month: "long", year: "numeric" })}
          · ${T.exams.length} papers · ${new Set(T.exams.map((e) => e.date)).size} exam days · ${T.halls.length} hall sessions
          · ${p.status === "published" ? '<span class="badge active">Published</span>' : '<span class="badge draft">Draft</span>'}</p>
      </div>
    </div>

    ${live ? `<div class="version-bar live">
        <i class="ti ti-broadcast"></i>
        <div class="vb-text"><b>This is the published version.</b> Lecturers can see it and download it.
          ${pendingCopy ? "You have a draft copy with changes that are not published yet." : "To change it, click <b>Edit</b>: you work on a copy, and everyone keeps seeing this version until you republish."}</div>
        <div class="vb-actions">
          <button class="btn small" data-vb="copy"><i class="ti ti-pencil"></i> ${pendingCopy ? "Open the draft copy" : "Edit a copy"}</button>
          <button class="btn light small" data-vb="unpublish"><i class="ti ti-eye-off"></i> Unpublish</button>
          <button class="btn light small danger" data-vb="delete"><i class="ti ti-trash"></i> Delete</button>
        </div>
      </div>` : original ? `<div class="version-bar copy">
        <i class="ti ti-copy"></i>
        <div class="vb-text"><b>Draft copy of a published timetable.</b> Lecturers still see the ${original.status === "published" ? "published" : "old"} version.
          Make your changes, then click <b>Republish</b> to replace it.</div>
        <div class="vb-actions">
          <button class="btn small" data-vb="republish"><i class="ti ti-send"></i> Republish…</button>
          <a class="btn light small" href="#timetable/${original.id}"><i class="ti ti-eye"></i> See the published version</a>
          <button class="btn light small danger" data-vb="discard"><i class="ti ti-trash"></i> Discard this copy</button>
        </div>
      </div>` : ""}

    <details class="health ${n("error") ? "bad" : n("warn") ? "meh" : "good"}" ${n("error") ? "open" : ""}>
      <summary>
        <span class="health-title"><i class="ti ${n("error") ? "ti-alert-triangle" : n("warn") ? "ti-alert-circle" : "ti-circle-check"}"></i>
          Health check: ${n("error") ? `${n("error")} problem${n("error") > 1 ? "s" : ""} to fix` : n("warn") ? "no problems, a few things to look at" : "everything looks good"}</span>
        <span class="health-counts">
          <span class="hc error">${n("error")} problems</span><span class="hc warn">${n("warn")} warnings</span><span class="hc info">${n("info")} notes</span>
        </span>
      </summary>
      <ul class="health-list">${checks.map((c) => `<li class="${c.level}">${esc(c.text)}</li>`).join("") || "<li class='info'>No issues found.</li>"}</ul>
    </details>

    <div class="tt-main">
      <div class="tabs tt-tabs" role="tablist">
        <button role="tab" data-view="streams">By stream</button>
        <button role="tab" data-view="halls">Halls &amp; staff</button>
        <button role="tab" data-view="load">Staff load</button>
      </div>
      ${ui.edit ? '<p class="edit-hint"><i class="ti ti-pointer"></i> Edit mode: click a paper or a hall to change it in the panel on the left.</p>' : ""}
      <div class="tt-body"></div>
    </div>

    <!-- LEFT SIDEBAR: Edit -->
    <aside class="drawer drawer-left" aria-label="Edit timetable" ${ui.edit ? "" : "hidden"}>
      <header class="drawer-head">
        <h2><i class="ti ti-pencil"></i> Edit timetable</h2>
        <button class="drawer-close" data-close-edit aria-label="Close the edit panel"><i class="ti ti-x"></i></button>
      </header>
      <div class="drawer-body" id="edit-panel"></div>
    </aside>

    <!-- RIGHT SIDEBAR: Load scale / AI assistant -->
    <aside class="drawer drawer-right" aria-label="${right === "ai" ? "AI assistant" : "Load scale"}" ${right ? "" : "hidden"}>
      <header class="drawer-head">
        <div class="drawer-tabs" role="tablist">
          <button role="tab" data-right="scale" class="${right === "scale" ? "active" : ""}" aria-selected="${right === "scale"}"><i class="ti ti-chart-bar"></i> Load scale</button>
          <button role="tab" data-right="ai" class="${right === "ai" ? "active" : ""}" aria-selected="${right === "ai"}"><i class="ti ti-sparkles"></i> AI assistant</button>
        </div>
        <button class="drawer-close" data-right="" aria-label="Close the side panel"><i class="ti ti-x"></i></button>
      </header>
      <div class="drawer-body" id="right-body"></div>
    </aside>`;

  // the timetable makes room for whichever sidebars are open
  root.classList.toggle("drawer-left-open", !!ui.edit);
  root.classList.toggle("drawer-right-open", !!right);
  syncDrawerPosition();

  root.querySelector("#download").addEventListener("click", () => downloadDialog(periodId, p));
  const rerender = (extra = {}) => renderTimetable(root, periodId, go, view, { ...ui, keep: true, ...extra });
  root.querySelector("#edit-toggle")?.addEventListener("click", () => rerender({ edit: !ui.edit, sel: null }));
  // published: edit through a draft copy
  async function editCopy(btn) {
    if (pendingCopy) return go(`timetable/${pendingCopy.id}`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> Making a copy…'; }
    try {
      const id = await copyPeriod(p.id);
      toast("Draft copy made. Change what you need, then click Republish. Everyone still sees the published version.");
      sessionStorage.setItem("openEdit", String(id));
      go(`timetable/${id}`);
    } catch (err) { toast(err.message || String(err), "error"); if (btn) btn.disabled = false; }
  }
  root.querySelector("#edit-copy")?.addEventListener("click", (e) => editCopy(e.currentTarget));
  root.querySelectorAll("[data-vb]").forEach((b) => b.addEventListener("click", async () => {
    const a = b.dataset.vb;
    if (a === "copy") return editCopy(b);
    if (a === "republish") return rerender({ edit: true, sel: null });
    if (a === "unpublish") {
      if (!confirm("Unpublish? Lecturers will no longer see this timetable. It becomes a draft you can edit and publish again.")) return;
      const { error } = await supabase.from("exam_periods").update({ status: "draft" }).eq("id", p.id);
      if (error) return toast(error.message, "error");
      toast("Unpublished — it's a draft again.");
      return rerender({});
    }
    if (a === "delete" || a === "discard") {
      if (a === "discard" ? !confirm("Discard this draft copy? Your changes in it are lost. The published version stays as it is.") : !confirmDelete(p)) return;
      try { await deletePeriod(p.id); } catch (err) { return toast(err.message, "error"); }
      toast(a === "discard" ? "Draft copy discarded." : "Published timetable deleted.");
      return go(a === "discard" && original ? `timetable/${original.id}` : "overview");
    }
  }));
  root.querySelector("#ai-toggle").addEventListener("click", () => rerender({ right: right === "ai" ? null : "ai" }));
  root.querySelector("#scale-toggle").addEventListener("click", () => rerender({ right: right === "scale" ? null : "scale" }));
  root.querySelectorAll("[data-right]").forEach((b) => b.addEventListener("click", () => rerender({ right: b.dataset.right || null })));
  root.querySelector("[data-close-edit]").addEventListener("click", () => rerender({ edit: false, sel: null }));
  root.querySelector("#publish")?.addEventListener("click", () => rerender({ edit: true, sel: null }));

  // the Edit panel (its tools are also used by the AI assistant)
  const editorObj = mountEditor({
    panel: root.querySelector("#edit-panel"), T, periodId,
    reload: (sel) => rerender({ sel }),
    onSelect: () => markSelected(null),
  });
  const editor = ui.edit ? editorObj : null;
  if (editor) editor.select(ui.sel?.type, ui.sel?.id);
  const rightBody = root.querySelector("#right-body");
  if (right === "ai") mountAI({ panel: rightBody, T, periodId, editor: editorObj, refresh: () => rerender({}) });
  if (right === "scale") mountScale({ panel: rightBody, T, ui, onWeek: (w) => { ui.week = w; } });
  function markSelected(sel) {
    root.querySelectorAll(".is-selected").forEach((x) => x.classList.remove("is-selected"));
    if (!sel) return;
    const attr = sel.type === "exam" ? "data-exam" : "data-hall";
    root.querySelectorAll(`[${attr}="${sel.id}"]`).forEach((x) => x.classList.add("is-selected"));
  }
  const body = root.querySelector(".tt-body");
  const tabs = root.querySelectorAll(".tt-tabs button");

  function show(v) {
    view = v;
    tabs.forEach((t) => { t.classList.toggle("active", t.dataset.view === v); t.setAttribute("aria-selected", t.dataset.view === v); });
    if (v === "streams") body.innerHTML = streamsView();
    if (v === "halls") body.innerHTML = hallsView();
    if (v === "load") body.innerHTML = loadView();
    if (ui.sel) markSelected(ui.sel);
  }
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.view)));

  // ----- 1. By stream: rows = streams, columns = exam days -----
  function streamsView() {
    const dates = [...new Set(T.exams.map((e) => e.date))].sort();
    const streamIds = [...new Set(T.exams.flatMap((e) => T.batchesOf[e.moduleId] || []))]
      .map((id) => T.batchById[id]).filter(Boolean)
      .sort((a, b) => b.intake - a.intake || String(a.stream).localeCompare(String(b.stream)));
    const cell = (b, d) => T.exams.filter((e) => e.date === d && (T.batchesOf[e.moduleId] || []).includes(b.id))
      .sort((x, y) => x.session.localeCompare(y.session))
      .map((e) => {
        const m = mod(e.moduleId);
        const rooms = hallsOfExam(e.id).map((h) => h.roomName).join(", ");
        return `<button class="paper ${e.session.toLowerCase()}" data-exam="${e.id}" title="${esc(m.name)}${e.locked ? " (locked)" : ""}">
          <span class="code">${esc(m.code)}${e.locked ? ' <i class="ti ti-lock lock" aria-label="locked"></i>' : ""}</span>
          <span class="time">${timeLabel(e.session, m.duration_hours)}</span>
          <span class="rooms">${esc(rooms)}</span></button>`;
      }).join("");
    let lastIntake = null;
    return `<div class="grid-wrap"><table class="tt-grid">
      <thead><tr><th class="sticky">Stream</th>${dates.map((d) => `<th>${fmtDate(d)}</th>`).join("")}</tr></thead>
      <tbody>${streamIds.map((b) => {
        const head = b.intake !== lastIntake ? `<tr class="intake-row"><td class="sticky" colspan="${dates.length + 1}">Intake ${b.intake} · Semester ${esc(b.semester)}</td></tr>` : "";
        lastIntake = b.intake;
        return head + `<tr><th class="sticky stream" scope="row">${esc(b.stream || b.degree)}<span class="muted small">${b.student_count ?? "?"} students</span></th>
          ${dates.map((d) => `<td>${cell(b, d)}</td>`).join("")}</tr>`;
      }).join("")}</tbody></table></div>
      <p class="legend"><span class="paper am mini">Morning 09:00</span><span class="paper pm mini">Afternoon 13:00</span> Click any paper for halls and staff.</p>`;
  }

  // ----- 2. Halls & staff: one row per hall per session (like the admin duty schedule) -----
  function hallsView() {
    const groups = new Map();
    T.halls.forEach((h) => { const k = `${h.date}|${h.session}`; (groups.get(k) || groups.set(k, []).get(k)).push(h); });
    return [...groups].map(([k, hs]) => {
      const [date, session] = k.split("|");
      return `<section class="day-block">
        <h3>${fmtDate(date, { weekday: "long", day: "numeric", month: "long" })} · ${session === "AM" ? "Morning" : "Afternoon"} (${String(SESSION_START[session]).padStart(2, "0")}:00)</h3>
        <div class="table-wrap"><table class="data duty-table">
          <thead><tr><th>Hall</th><th>Papers</th><th>Students</th><th>Supervisor</th><th>Invigilators</th><th>Hall attendant</th></tr></thead>
          <tbody>${hs.map((h) => {
            const by = (r) => h.duties.filter((d) => d.role === r).map((d) => esc(staffName(d.staffId)) + (d.locked ? ' <i class="ti ti-lock lock" aria-label="locked"></i>' : "")).join("<br>") || '<span class="missing">—</span>';
            const total = h.exams.reduce((a, x) => a + x.seats, 0);
            return `<tr data-hall="${h.id}" tabindex="0" title="Click for details">
              <td><b>${esc(h.roomName)}</b></td>
              <td>${h.exams.map((x) => {
                const e = T.examById[x.examId]; const m = mod(e?.module_id);
                return `<div><b>${esc(m.code)}</b> ${esc(m.name)} <span class="muted small">· ${streamsOf(m.id).map((b) => esc(b.stream)).join(", ")} · ${x.seats}</span></div>`;
              }).join("")}</td>
              <td class="${total > h.cap ? "over" : ""}">${total} / ${h.cap}</td>
              <td>${by("SUPERVISOR")}</td><td>${by("INVIGILATOR")}</td><td>${by("ATTENDANT")}</td>
            </tr>`;
          }).join("")}</tbody></table></div></section>`;
    }).join("") || `<p class="muted">No halls in this timetable.</p>`;
  }

  // ----- 3. Staff load: is the work shared fairly? -----
  function loadView() {
    const count = {};
    T.halls.forEach((h) => h.duties.forEach((d) => {
      const c = (count[d.staffId] ||= { SUPERVISOR: 0, INVIGILATOR: 0, ATTENDANT: 0 });
      c[d.role]++;
    }));
    const rows = T.staffLite.filter((s) => count[s.id] || !s.onHold)
      .map((s) => ({ ...s, c: count[s.id] || { SUPERVISOR: 0, INVIGILATOR: 0, ATTENDANT: 0 } }))
      .map((s) => ({ ...s, total: s.c.SUPERVISOR + s.c.INVIGILATOR + s.c.ATTENDANT }))
      .sort((a, b) => GRADE_ORDER.indexOf(a.grade) - GRADE_ORDER.indexOf(b.grade) || b.total - a.total);
    const avg = {};
    GRADE_ORDER.forEach((g) => { const r = rows.filter((x) => x.grade === g); if (r.length) avg[g] = r.reduce((a, x) => a + x.total, 0) / r.length; });
    return `<div class="load-summary">${Object.entries(avg).map(([g, a]) =>
      `<div class="stat static"><span class="num">${a.toFixed(1)}</span><span class="lab">avg duties · ${GRADE_NAMES[g]}</span></div>`).join("")}</div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Grade</th><th>Supervisor</th><th>Invigilator</th><th>Hall attendant</th><th>Total</th></tr></thead>
        <tbody>${rows.map((s) => `<tr data-staff="${s.id}" tabindex="0" title="Click to see their duties">
          <td>${esc(s.name)}</td><td>${GRADE_NAMES[s.grade] || s.grade}</td>
          <td>${s.c.SUPERVISOR || ""}</td><td>${s.c.INVIGILATOR || ""}</td><td>${s.c.ATTENDANT || ""}</td>
          <td><b>${s.total}</b></td></tr>`).join("")}</tbody></table></div>`;
  }

  // ----- details pop-up -----
  function details(html) {
    const dlg = document.createElement("dialog");
    dlg.className = "form-dialog detail-dialog";
    dlg.innerHTML = `<div class="detail">${html}<div class="dialog-actions"><button class="btn" value="close">Close</button></div></div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('[value="close"]').onclick = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  const hallCard = (h) => {
    const total = h.exams.reduce((a, x) => a + x.seats, 0);
    return `<div class="hall-card">
      <p><b>${esc(h.roomName)}</b> · ${total} of ${h.cap} seats</p>
      <ul>${h.duties.map((d) => `<li><span class="role">${ROLE_NAMES[d.role]}</span> ${esc(staffName(d.staffId))}</li>`).join("")}</ul>
    </div>`;
  };
  body.addEventListener("click", (e) => {
    const paper = e.target.closest("[data-exam]");
    const hallRow = e.target.closest("[data-hall]");
    const staffRow = e.target.closest("[data-staff]");
    if (editor && (paper || hallRow)) {           // edit mode: open it in the Edit panel
      const sel = paper ? { type: "exam", id: Number(paper.dataset.exam) } : { type: "hall", id: Number(hallRow.dataset.hall) };
      editor.select(sel.type, sel.id);
      ui.sel = sel;
      return markSelected(sel);
    }
    if (paper) {
      const ex = T.exams.find((x) => x.id === Number(paper.dataset.exam));
      const m = mod(ex.moduleId);
      const hs = hallsOfExam(ex.id);
      details(`<h2>${esc(m.code)} · ${esc(m.name)}</h2>
        <p class="muted">${fmtDate(ex.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${timeLabel(ex.session, m.duration_hours)}</p>
        <p><b>Streams:</b> ${streamsOf(m.id).map((b) => `Intake ${b.intake} ${esc(b.stream)}`).join(", ")}<br>
        <b>Students:</b> ${T.moduleStudents[m.id] ?? "?"} (${m.repeat_students || 0} repeat)</p>
        <h3 class="gen-h">Halls</h3>
        <div class="hall-cards">${hs.map((h) => {
          const seats = h.exams.find((x) => x.examId === ex.id)?.seats;
          const others = h.exams.filter((x) => x.examId !== ex.id).map((x) => mod(T.examById[x.examId]?.module_id).code);
          return hallCard(h).replace("</p>", ` · ${seats} for this paper${others.length ? ` · shared with ${esc(others.join(", "))}` : ""}</p>`);
        }).join("")}</div>`);
    } else if (hallRow) {
      const h = T.halls.find((x) => x.id === Number(hallRow.dataset.hall));
      details(`<h2>${esc(h.roomName)}</h2>
        <p class="muted">${fmtDate(h.date, { weekday: "long", day: "numeric", month: "long" })} · ${h.session === "AM" ? "Morning" : "Afternoon"}</p>
        ${h.exams.map((x) => { const m = mod(T.examById[x.examId]?.module_id);
          return `<p><b>${esc(m.code)}</b> ${esc(m.name)} — ${x.seats} students (${streamsOf(m.id).map((b) => esc(b.stream)).join(", ")})</p>`; }).join("")}
        <div class="hall-cards">${hallCard(h)}</div>`);
    } else if (staffRow) {
      const id = Number(staffRow.dataset.staff);
      const mine = T.halls.filter((h) => h.duties.some((d) => d.staffId === id));
      details(`<h2>${esc(staffName(id))}</h2>
        <table class="data"><thead><tr><th>Date</th><th>Session</th><th>Hall</th><th>Role</th><th>Papers</th></tr></thead>
        <tbody>${mine.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${h.session}</td><td>${esc(h.roomName)}</td>
          <td>${ROLE_NAMES[h.duties.find((d) => d.staffId === id).role]}</td>
          <td>${h.exams.map((x) => esc(mod(T.examById[x.examId]?.module_id).code)).join(", ")}</td></tr>`).join("") || "<tr><td colspan=5 class='muted'>No duties.</td></tr>"}</tbody></table>`);
    }
  });
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("[data-hall],[data-staff]")) e.target.click(); });

  show(view);
  if (ui.sel) markSelected(ui.sel);
  if (ui.keep) root.scrollTop = scrollY;
}

// =====================================================================
// DOWNLOADS — PDFs to email to students and staff
// =====================================================================
async function downloadDialog(periodId, period) {
  const V = await loadPeriod(periodId);
  const batches = timetableBatches(V);
  const dlg = document.createElement("dialog");
  dlg.className = "form-dialog";
  dlg.innerHTML = `<form method="dialog">
      <h2>Download</h2>
      <p class="muted">PDF files to email to students and staff.${period.status === "published" ? "" : " <b>This timetable is still a draft.</b>"}</p>
      <div class="dl-options">
        <label class="dl-opt"><input type="radio" name="dl" value="batches" checked>
          <span><b>Every batch's timetable</b><small>One page per batch (${batches.length} batches) — date, time, module and exam hall. Ideal to email to students.</small></span></label>
        <label class="dl-opt"><input type="radio" name="dl" value="batch">
          <span><b>One batch</b><small><select id="dl-batch">${batches.map((b) => `<option value="${b.id}">Intake ${b.intake} · ${esc(b.stream || b.degree)}</option>`).join("")}</select></small></span></label>
        <label class="dl-opt"><input type="radio" name="dl" value="halls">
          <span><b>Supervisor / invigilator list (whole timetable)</b><small>The faculty layout: week by week, every hall with papers, students, supervisor, invigilators and hall attendant.</small></span></label>
        <label class="dl-opt"><input type="radio" name="dl" value="staff">
          <span><b>Staff duty lists</b><small>One page per staff member: where and when they must be.</small></span></label>
        <label class="dl-opt"><input type="radio" name="dl" value="print">
          <span><b>Print this page</b><small>Prints the view on screen (By stream / Halls &amp; staff / Staff load).</small></span></label>
      </div>
      <div class="dialog-actions"><button type="button" class="btn light" value="cancel">Cancel</button><button class="btn"><i class="ti ti-download"></i> Download PDF</button></div>
    </form>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("#dl-batch").addEventListener("focus", () => { dlg.querySelector('[value="batch"]').checked = true; });
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const kind = dlg.querySelector('[name="dl"]:checked').value;
    if (kind === "print") { dlg.close(); setTimeout(() => window.print(), 200); return; }
    const btn = dlg.querySelector("button:not([value])");
    btn.disabled = true; btn.textContent = "Making the PDF…";
    try {
      if (kind === "batches") await pdfBatches(V, period, batches.map((b) => b.id), "exam-timetable-all-batches.pdf");
      if (kind === "batch") {
        const b = V.batchById[dlg.querySelector("#dl-batch").value];
        await pdfBatches(V, period, [b.id], `exam-timetable-intake-${b.intake}-${String(b.stream).replace(/\W+/g, "-")}.pdf`);
      }
      if (kind === "halls") await pdfFacultySheet(V, period, { filename: "supervisor-invigilator-list.pdf" });
      if (kind === "staff") await pdfAllStaff(V, period);
      dlg.close();
    } catch (err) { toast(err.message || String(err), "error"); btn.disabled = false; btn.textContent = "Download PDF"; }
  });
}
