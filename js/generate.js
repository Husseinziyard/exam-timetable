// =====================================================================
// GENERATE: the form the admin fills in, then run the engine and save
// the result as a DRAFT timetable (nothing is shown to lecturers or
// students until it is published).
// =====================================================================
import { supabase } from "./config.js";
import { generate, workingDays } from "./engine.js";
import { toast } from "./crud.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const iso = (d) => d.toISOString().slice(0, 10);
const GRADE_NAMES = { PROF: "Professor", SL1: "SL Gr. I", SL2: "SL Gr. II", LECT: "Lecturer", INSTR: "Instructor", MIL: "Military", HA: "Hall attendant" };

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Everything the engine needs, straight from the database
export async function loadAll() {
  const [departments, batches, modules, links, rooms, staff, leave, holidays, settings] = await Promise.all([
    q(supabase.from("departments").select("*").order("name")),
    q(supabase.from("batches").select("*").order("intake")),
    q(supabase.from("modules").select("*").order("code")),
    q(supabase.from("module_batches").select("*")),
    q(supabase.from("rooms").select("*").order("name")),
    q(supabase.from("lecturers").select("*").order("full_name")),
    q(supabase.from("lecturer_leave").select("*")),
    q(supabase.from("holidays").select("*")),
    q(supabase.from("settings").select("*")),
  ]);
  const batchesOf = {};
  links.forEach((l) => (batchesOf[l.module_id] ||= []).push(l.batch_id));
  const setting = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  return { departments, batches, modules, batchesOf, rooms, staff, leave, holidays, setting };
}

// Students sitting a paper = proper students of its streams (or the override) + repeat students
export function studentsFor(m, batchesOf, batchById) {
  const proper = m.expected_students ?? (batchesOf[m.id] || []).reduce((a, b) => a + (batchById[b]?.student_count || 0), 0);
  return proper + (m.repeat_students || 0);
}

// =====================================================================
// The form
// =====================================================================
export async function openGenerateDialog(onSaved) {
  let data;
  try { data = await loadAll(); } catch (err) { return toast(err.message, "error"); }
  const { departments, batches, modules, batchesOf, rooms, staff, leave, holidays, setting } = data;
  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));
  const activeBatches = batches.filter((b) => !b.on_hold);
  const intakes = [...new Set(activeBatches.map((b) => b.intake))].sort((a, b) => b - a);

  // default period: next Monday, four weeks
  const start = new Date(); start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7 || 7));
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 25);
  const monthName = start.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  const dlg = document.createElement("dialog");
  dlg.className = "form-dialog gen-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>Generate timetable</h2>
      <p class="muted">Pick the period and what to include. Everything else is filled in for you. The result is saved as a <b>draft</b> — nobody else sees it until you publish.</p>

      <div class="grid">
        <div class="wide"><label for="g-name">Name</label><input id="g-name" value="End-semester examinations – ${esc(monthName)}" required></div>
        <div><label for="g-start">First exam day *</label><input id="g-start" type="date" value="${iso(start)}" required></div>
        <div><label for="g-end">Last exam day *</label><input id="g-end" type="date" value="${iso(end)}" required></div>
      </div>

      <h3 class="gen-h">Intakes</h3>
      <div class="pills" id="g-intakes">${intakes.map((i) => `<label class="pill"><input type="checkbox" value="${i}" checked> Intake ${i}</label>`).join("") || '<p class="muted">No batches yet — add batches first.</p>'}</div>

      <h3 class="gen-h">Departments</h3>
      <div class="pills" id="g-depts">${departments.filter((d) => !d.on_hold).map((d) => `<label class="pill"><input type="checkbox" value="${d.id}" checked> ${esc(d.name.replace("Department of ", ""))}</label>`).join("")}</div>

      <h3 class="gen-h">Modules <span class="muted small" id="g-mod-count"></span></h3>
      <details class="picker"><summary>Choose modules (all are included by default)</summary>
        <div class="picker-tools"><button type="button" class="link" data-all="g-mods">Select all</button><button type="button" class="link" data-none="g-mods">Clear</button></div>
        <div class="checks" id="g-mods"></div>
      </details>

      <h3 class="gen-h">Staff <span class="muted small" id="g-staff-count"></span></h3>
      <details class="picker"><summary>Choose staff (everyone active is included by default)</summary>
        <div class="picker-tools">
          <button type="button" class="link" data-all="g-staff">Select all</button><button type="button" class="link" data-none="g-staff">Clear</button>
          <select id="g-staff-grade" aria-label="Show grade"><option value="">All grades</option>${Object.entries(GRADE_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        </div>
        <div class="checks" id="g-staff">${staff.filter((s) => !s.on_hold).map((s) => `
          <label class="check" data-grade="${s.grade}"><input type="checkbox" value="${s.id}" checked> ${esc((s.title ? s.title + " " : "") + s.full_name)} <span class="muted small">· ${GRADE_NAMES[s.grade] || s.grade}</span></label>`).join("")}</div>
      </details>

      <h3 class="gen-h">Halls <span class="muted small" id="g-room-count"></span></h3>
      <div class="pills" id="g-rooms">${rooms.filter((r) => !r.on_hold).map((r) => `<label class="pill"><input type="checkbox" value="${r.id}" checked> ${esc(r.name)} <span class="muted small">(${r.exam_capacity})</span></label>`).join("")}</div>

      <h3 class="gen-h">Rules</h3>
      <div class="grid">
        <div><label for="g-thr">Second invigilator when a hall has more than</label><input id="g-thr" type="number" min="1" value="${Number(setting.second_invigilator_above ?? 60)}"></div>
        <div><label for="g-gap">Study days between a stream's exams (at least)</label><input id="g-gap" type="number" min="0" max="5" value="1"></div>
      </div>

      <div class="gen-summary" id="g-summary"></div>
      <p class="msg error form-msg"></p>
      <div class="dialog-actions">
        <button type="button" class="btn light" value="cancel">Cancel</button>
        <button type="submit" class="btn big" id="g-go">Generate</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());

  const $ = (sel) => dlg.querySelector(sel);
  const checked = (id) => [...dlg.querySelectorAll(`#${id} input:checked`)].map((i) => Number(i.value));

  // modules shown depend on the intakes + departments ticked
  let modSelection = new Set(modules.filter((m) => !m.on_hold).map((m) => m.id));
  function eligibleModules() {
    const ins = new Set(checked("g-intakes")), deps = new Set(checked("g-depts"));
    return modules.filter((m) => !m.on_hold && (batchesOf[m.id] || []).some((b) =>
      ins.has(batchById[b]?.intake) && deps.has(batchById[b]?.department_id) && !batchById[b]?.on_hold));
  }
  function drawModules() {
    const list = eligibleModules();
    $("#g-mods").innerHTML = list.map((m) => {
      const streams = (batchesOf[m.id] || []).map((b) => batchById[b]?.stream || "?").join(", ");
      return `<label class="check"><input type="checkbox" value="${m.id}" ${modSelection.has(m.id) ? "checked" : ""}> <b>${esc(m.code)}</b> ${esc(m.name)} <span class="muted small">· ${esc(streams)}</span></label>`;
    }).join("") || '<p class="muted">No modules for the selected intakes and departments.</p>';
    summary();
  }
  function selectedModules() {
    const ids = new Set(checked("g-mods"));
    return eligibleModules().filter((m) => ids.has(m.id));
  }
  function summary() {
    const mods = selectedModules();
    const s = $("#g-start").value, e = $("#g-end").value;
    const days = s && e && s <= e ? workingDays(s, e, holidays.map((h) => h.holiday_date)) : [];
    const streams = new Set(mods.flatMap((m) => batchesOf[m.id] || []));
    const perStream = {};
    mods.forEach((m) => (batchesOf[m.id] || []).forEach((b) => (perStream[b] = (perStream[b] || 0) + 1)));
    const perIntake = {};
    for (const b in perStream) { const i = batchById[b].intake; perIntake[i] = Math.max(perIntake[i] || 0, perStream[b]); }
    const needed = Object.values(perIntake).reduce((a, b) => a + b, 0);
    const noCount = [...streams].filter((b) => !batchById[b].student_count).map((b) => `${batchById[b].intake} ${batchById[b].stream}`);
    $("#g-mod-count").textContent = `· ${mods.length} selected`;
    $("#g-staff-count").textContent = `· ${checked("g-staff").length} selected`;
    $("#g-room-count").textContent = `· ${checked("g-rooms").length} selected`;
    $("#g-summary").innerHTML = `
      <p><b>${mods.length}</b> papers for <b>${streams.size}</b> streams · <b>${days.length}</b> exam days available
      (weekends and holidays skipped) · about <b>${needed}</b> needed.</p>
      ${days.length && needed > days.length ? `<p class="warn-text">The period looks too short. Some papers may not fit.</p>` : ""}
      ${noCount.length ? `<p class="warn-text">No student count for: ${esc(noCount.join(", "))}. Add it in Batches, or those papers get 0 seats.</p>` : ""}`;
  }

  dlg.addEventListener("change", (e) => {
    if (e.target.closest("#g-mods")) {
      modSelection = new Set(checked("g-mods"));
    }
    if (e.target.closest("#g-intakes, #g-depts")) drawModules();
    else summary();
  });
  dlg.addEventListener("click", (e) => {
    const all = e.target.dataset.all, none = e.target.dataset.none;
    if (!all && !none) return;
    dlg.querySelectorAll(`#${all || none} label:not([hidden]) input`).forEach((i) => (i.checked = !!all));
    if ((all || none) === "g-mods") modSelection = new Set(checked("g-mods"));
    summary();
  });
  $("#g-staff-grade").addEventListener("change", (e) => {
    dlg.querySelectorAll("#g-staff label").forEach((l) => (l.hidden = !!e.target.value && l.dataset.grade !== e.target.value));
  });
  $("#g-start").addEventListener("input", summary);
  $("#g-end").addEventListener("input", summary);
  drawModules();

  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $(".form-msg");
    const show = (t) => { msg.textContent = t; msg.classList.add("show"); };
    msg.classList.remove("show");

    const s = $("#g-start").value, en = $("#g-end").value;
    if (!s || !en || s > en) return show("Check the first and last exam days.");
    const mods = selectedModules();
    if (!mods.length) return show("No modules selected.");
    const roomIds = new Set(checked("g-rooms"));
    const staffIds = new Set(checked("g-staff"));
    if (!roomIds.size) return show("Tick at least one hall.");

    const opts = {
      days: workingDays(s, en, holidays.map((h) => h.holiday_date)),
      threshold: Number($("#g-thr").value) || 60,
      minGap: Number($("#g-gap").value) || 0,
      seed: Date.now() % 100000,
    };
    if (!opts.days.length) return show("There are no working days in that period.");

    const input = buildInput({ mods, batchesOf, batchById, departments, rooms: rooms.filter((r) => roomIds.has(r.id)),
      staff: staff.filter((x) => staffIds.has(x.id)), leave, opts });

    const btn = $("#g-go");
    btn.disabled = true; btn.textContent = "Generating…";
    try {
      const result = generate(input);
      const periodId = await saveTimetable({
        name: $("#g-name").value.trim() || "Exam timetable", start: s, end: en,
        options: { ...opts, days: undefined, intakes: checked("g-intakes"), departments: checked("g-depts"),
          modules: mods.map((m) => m.id), rooms: [...roomIds], staff: [...staffIds] },
      }, result);
      dlg.close();
      const errs = result.warnings.filter((w) => w.level === "error").length;
      toast(errs ? `Draft saved with ${errs} problem${errs > 1 ? "s" : ""} to fix.` : "Draft timetable generated.", errs ? "error" : "ok");
      onSaved(periodId);
    } catch (err) {
      show(err.message || String(err));
      btn.disabled = false; btn.textContent = "Generate";
    }
  });
}

// Turn database rows into the engine's input
export function buildInput({ mods, batchesOf, batchById, departments, rooms, staff, leave, opts, locked = [] }) {
  const deptById = Object.fromEntries(departments.map((d) => [d.id, d]));
  const batches = {};
  for (const m of mods) for (const b of batchesOf[m.id] || []) {
    const row = batchById[b];
    batches[b] = { intake: row.intake, stream: row.stream, onePerDay: !!deptById[row.department_id]?.one_exam_per_day,
      label: `Intake ${row.intake} · ${row.stream || row.degree}` };
  }
  // papers in the same slot group (e.g. language electives) sit together = one unit
  const groups = new Map();
  for (const m of mods) {
    const key = m.slot_group ? `g:${m.slot_group}` : `m:${m.id}`;
    const u = groups.get(key) || { key, modules: [], batchIds: [], students: 0 };
    const n = studentsFor(m, batchesOf, batchById);
    u.modules.push({ id: m.id, code: m.code, students: n });
    u.batchIds = [...new Set([...u.batchIds, ...(batchesOf[m.id] || [])])];
    u.students += n;
    groups.set(key, u);
  }
  const units = [...groups.values()].filter((u) => u.batchIds.length);
  for (const l of locked) {                 // keep locked papers where they are
    const u = units.find((x) => x.modules.some((m) => m.id === l.moduleId));
    if (u) u.locked = { date: l.date, session: l.session };
  }
  const leaveBy = {};
  leave.forEach((l) => (leaveBy[l.lecturer_id] ||= []).push([l.start_date, l.end_date]));
  return {
    units, batches, opts,
    rooms: rooms.map((r) => ({ id: r.id, name: r.name, cap: r.exam_capacity })),
    staff: staff.filter((s) => !s.on_hold).map((s) => ({
      id: s.id, name: `${s.title ? s.title + " " : ""}${s.full_name}`, grade: s.grade,
      canSup: !!s.can_supervise, canInv: !!s.can_invigilate, isHA: s.grade === "HA", leave: leaveBy[s.id] || [],
    })),
  };
}

// Save: period -> exams -> hall sessions -> which papers in which hall -> duties
export async function saveTimetable(period, result, existingId = null) {
  let periodId = existingId;
  if (!periodId) {
    const row = await q(supabase.from("exam_periods").insert({
      name: period.name, start_date: period.start, end_date: period.end, status: "draft",
      options: period.options, generated_at: new Date().toISOString(),
    }).select("id").single());
    periodId = row.id;
  }
  try {
    const exams = result.exams.length ? await q(supabase.from("exams").insert(
      result.exams.map((e) => ({ period_id: periodId, module_id: e.moduleId, exam_date: e.date, session: e.session }))
    ).select("id,module_id")) : [];
    const examId = Object.fromEntries(exams.map((e) => [e.module_id, e.id]));

    const hs = result.halls.length ? await q(supabase.from("hall_sessions").insert(
      result.halls.map((h) => ({ period_id: periodId, exam_date: h.date, session: h.session, room_id: h.roomId }))
    ).select("id,exam_date,session,room_id")) : [];
    const hallId = Object.fromEntries(hs.map((h) => [`${h.exam_date}|${h.session}|${h.room_id}`, h.id]));

    const eh = result.halls.flatMap((h) => h.exams.map((x) => ({
      exam_id: examId[x.moduleId], hall_session_id: hallId[`${h.date}|${h.session}|${h.roomId}`], seats_used: x.seats })));
    if (eh.length) await q(supabase.from("exam_halls").insert(eh));

    const du = result.halls.flatMap((h) => (h.duties || []).map((d) => ({
      hall_session_id: hallId[`${h.date}|${h.session}|${h.roomId}`], lecturer_id: d.staffId, role: d.role, locked: !!d.locked })));
    if (du.length) await q(supabase.from("duties").insert(du));
  } catch (err) {
    if (!existingId) await supabase.from("exam_periods").delete().eq("id", periodId);   // don't leave half a timetable
    throw err;
  }
  return periodId;
}
