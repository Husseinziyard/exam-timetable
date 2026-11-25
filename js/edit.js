// =====================================================================
// MANUAL CHANGES (the left "Edit" panel on the timetable page)
//   • move a paper to another day / session
//   • replace, add or remove a supervisor / invigilator / hall attendant
//   • lock papers and duties so a re-plan keeps them
//   • re-plan everything that is not locked
//   • publish (allocates seats first) / unpublish
// Every change is saved straight away; the health check then re-runs.
// =====================================================================
import { supabase } from "./config.js";
import { toast } from "./crud.js";
import { generate, workingDays, allocate, GRADE_WEIGHT, timeLabel, unavailable } from "./engine.js";
import { buildInput, saveTimetable, loadAll } from "./generate.js";
import { seatLabel, perRowOf } from "./viewer.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s, o = { weekday: "short", day: "2-digit", month: "short" }) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const ROLE = { SUPERVISOR: "Supervisor", INVIGILATOR: "Invigilator", ATTENDANT: "Hall attendant" };
const GRADE = { PROF: "Prof", SL1: "SL I", SL2: "SL II", LECT: "Lect", INSTR: "Instr", MIL: "Mil", HA: "HA" };

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Who may take a role
const canDo = (s, role) => !s.on_hold && (
  role === "SUPERVISOR" ? s.can_supervise : role === "ATTENDANT" ? s.grade === "HA" : s.can_invigilate && s.grade !== "HA");

// Weighted duty load across the whole timetable (Professors count more, so they get fewer)
function loads(T) {
  const l = {};
  T.halls.forEach((h) => h.duties.forEach((d) => {
    const g = T.staffById[d.staffId]?.grade;
    l[d.staffId] = (l[d.staffId] || 0) + (GRADE_WEIGHT[g] || 1);
  }));
  return l;
}
const busyIn = (T, date, session) =>
  new Set(T.halls.filter((h) => h.date === date && h.session === session).flatMap((h) => h.duties.map((d) => d.staffId)));
const onLeave = (T, id, date) => (T.staffLite.find((s) => s.id === id)?.leave || []).some(([a, b]) => date >= a && date <= b);

// Free, eligible people for a role in a session, least-loaded first
export function candidates(T, date, session, role, keep = null) {
  const busy = busyIn(T, date, session), load = loads(T);
  return Object.values(T.staffById)
    .filter((s) => canDo(s, role) && (s.id === keep || !busy.has(s.id)) && !onLeave(T, s.id, date) &&
      (s.id === keep || !unavailable(T.staffLite.find((x) => x.id === s.id) || {}, date, session)))
    .map((s) => ({ s, load: load[s.id] || 0 }))
    .sort((a, b) => a.load - b.load || a.s.full_name.localeCompare(b.s.full_name));
}

// What happens if paper e moves to day d, session s (used by the Edit panel and the AI assistant)
export function slotStatus(T, e, d, s) {
  if (d === e.date && s === e.session) return { cls: "cur", note: "current" };
  if (!T.days.includes(d) || !["AM", "PM"].includes(s)) return { cls: "bad", note: "not an exam day in this period" };
  const m = T.moduleById[e.moduleId] || {};
  const streams = T.batchesOf[e.moduleId] || [];
  const sameSlot = T.exams.some((x) => x.id !== e.id && x.date === d && x.session === s && (T.batchesOf[x.moduleId] || []).some((b) => streams.includes(b)));
  if (sameSlot) return { cls: "bad", note: "clash: a stream already sits a paper" };
  const sameDay = T.exams.some((x) => x.id !== e.id && x.date === d && (T.batchesOf[x.moduleId] || []).some((b) => streams.includes(b)));
  const strict = streams.some((b) => T.batchLite[b]?.onePerDay);
  if (sameDay) return { cls: strict ? "bad" : "warn", note: strict ? "one-exam-per-day department" : "2nd exam that day" };
  const used = T.halls.filter((h) => h.date === d && h.session === s).reduce((a, h) => a + h.exams.reduce((x, y) => x + y.seats, 0), 0);
  const cap = Object.values(T.roomById).filter((r) => !r.on_hold).reduce((a, r) => a + r.exam_capacity, 0);
  if (used + (T.moduleStudents[m.id] || 0) > cap) return { cls: "bad", note: "not enough seats" };
  return { cls: "ok", note: "free" };
}

// =====================================================================
export function mountEditor({ panel, T, periodId, reload, onSelect }) {
  let sel = null;          // { type: "exam" | "hall", id }
  const name = (id) => { const s = T.staffById[id]; return s ? `${s.title ? s.title + " " : ""}${s.full_name}` : "?"; };
  const mod = (id) => T.moduleById[id] || { code: "?", name: "?" };
  const examOf = (id) => T.exams.find((e) => e.id === id);
  const hallsOf = (examId) => T.halls.filter((h) => h.exams.some((x) => x.examId === examId));

  function draw() {
    if (!sel) {
      panel.innerHTML = `
        <div class="ep-head"><h3>Edit timetable</h3></div>
        <p class="muted small">Click a <b>paper</b> (By stream) or a <b>hall</b> (Halls &amp; staff) to change it.
          Everything you change is <b>locked</b>, so re-planning keeps it.</p>
        <div class="ep-block">
          <p class="ep-label">Re-plan</p>
          <p class="small muted">Plan again everything that is not locked: dates, halls and staff. Use this after changing data (e.g. a lecturer on leave).</p>
          <button class="btn light full" data-act="replan"><i class="ti ti-refresh"></i> Re-plan (keep locked)</button>
          <p class="small muted">${T.exams.filter((e) => e.locked).length} papers and ${T.halls.reduce((a, h) => a + h.duties.filter((d) => d.locked).length, 0)} duties locked.</p>
          ${T.exams.some((e) => e.locked) || T.halls.some((h) => h.duties.some((d) => d.locked)) ? `<button class="link" data-act="unlock-all">Unlock everything</button>` : ""}
        </div>
        <div class="ep-block">
          <p class="ep-label">${T.period.status === "published" ? "Published" : "Publish"}</p>
          ${T.period.status === "published"
            ? `<p class="small muted">Lecturers and students can see this timetable. Changes you make now are visible to them straight away.</p>
               <button class="btn light full" data-act="seats"><i class="ti ti-armchair"></i> Re-allocate seats</button>
               <button class="btn light full" data-act="unpublish"><i class="ti ti-eye-off"></i> Unpublish</button>`
            : `<p class="small muted">Publishing allocates seats (index order, repeat students at the back) and shows the timetable to lecturers and students.</p>
               <button class="btn full" data-act="publish"><i class="ti ti-send"></i> Allocate seats &amp; publish</button>`}
        </div>`;
      return;
    }
    if (sel.type === "exam") return drawExam(examOf(sel.id));
    if (sel.type === "hall") return drawHall(T.halls.find((h) => h.id === sel.id));
  }

  // ----- a paper: move it, lock it -----
  function drawExam(e) {
    if (!e) { sel = null; return draw(); }
    const m = mod(e.moduleId);
    const streams = T.batchesOf[m.id] || [];
    const days = T.days;
    // what happens if the paper moves to each slot
    const options = days.flatMap((d) => ["AM", "PM"].map((s) => ({ d, s, ...slotStatus(T, e, d, s) })));
    panel.innerHTML = `
      <div class="ep-head"><button class="link" data-act="back"><i class="ti ti-arrow-left"></i> Back</button></div>
      <h3>${esc(m.code)}</h3>
      <p class="small">${esc(m.name)}<br><span class="muted">${streams.map((b) => T.batchLite[b]?.label).join(", ")} · ${T.moduleStudents[m.id] ?? "?"} students</span></p>
      <p class="small"><b>Now:</b> ${fmt(e.date, { weekday: "long", day: "numeric", month: "long" })} · ${timeLabel(e.session, m.duration_hours)}
        <br><b>Halls:</b> ${hallsOf(e.id).map((h) => esc(h.roomName)).join(", ") || "none"}</p>
      <div class="ep-block">
        <label class="ep-label" for="ep-slot">Move to</label>
        <select id="ep-slot" size="8" class="slot-list">${options.map((o) =>
          `<option value="${o.d}|${o.s}" class="${o.cls}" ${o.cls === "cur" ? "selected" : ""} ${o.cls === "bad" ? "disabled" : ""}>
            ${fmt(o.d)} ${o.s === "AM" ? "morning" : "afternoon"} — ${o.note}</option>`).join("")}</select>
        <p class="small muted">Greyed-out options would break a rule. Halls and staff for the paper are re-assigned automatically.</p>
        <button class="btn full" data-act="move">Move paper</button>
      </div>
      <div class="ep-block">
        <label class="check"><input type="checkbox" data-act="lock-exam" ${e.locked ? "checked" : ""}> Lock this paper's date</label>
      </div>`;
  }

  // ----- a hall: replace / add / remove staff, lock -----
  function drawHall(h) {
    if (!h) { sel = null; return draw(); }
    const total = h.exams.reduce((a, x) => a + x.seats, 0);
    const needInv = total > T.threshold ? 2 : 1;
    const count = (r) => h.duties.filter((d) => d.role === r).length;
    const opts = (role, keep) => candidates(T, h.date, h.session, role, keep).map(({ s, load }) =>
      `<option value="${s.id}" ${s.id === keep ? "selected" : ""}>${esc(name(s.id))} · ${GRADE[s.grade] || s.grade} · load ${load.toFixed(1)}</option>`).join("");
    panel.innerHTML = `
      <div class="ep-head"><button class="link" data-act="back"><i class="ti ti-arrow-left"></i> Back</button></div>
      <h3>${esc(h.roomName)}</h3>
      <p class="small">${fmt(h.date, { weekday: "long", day: "numeric", month: "long" })} · ${h.session === "AM" ? "Morning" : "Afternoon"}
        <br><span class="muted">${total} / ${h.cap} seats · ${h.exams.map((x) => esc(mod(T.examById[x.examId]?.module_id).code)).join(", ")}</span></p>
      ${h.duties.map((d) => `
        <div class="ep-duty">
          <label class="ep-label" for="d-${d.id}">${ROLE[d.role]}</label>
          <select id="d-${d.id}" data-duty="${d.id}">${opts(d.role, d.staffId)}</select>
          <div class="ep-row">
            <label class="check small"><input type="checkbox" data-lock-duty="${d.id}" ${d.locked ? "checked" : ""}> Locked</label>
            <button class="link danger" data-remove="${d.id}">Remove</button>
          </div>
        </div>`).join("")}
      <div class="ep-block">
        <p class="ep-label">Add</p>
        <div class="ep-add">
          <button class="btn light small" data-add="SUPERVISOR">+ Supervisor</button>
          <button class="btn light small" data-add="INVIGILATOR">+ Invigilator</button>
          <button class="btn light small" data-add="ATTENDANT">+ Hall attendant</button>
        </div>
        <p class="small muted">Needs 1 supervisor, ${needInv} invigilator${needInv > 1 ? "s" : ""} and 1 hall attendant (has ${count("SUPERVISOR")}, ${count("INVIGILATOR")}, ${count("ATTENDANT")}).
          The list shows only people free in this session, least busy first.</p>
      </div>`;
  }

  // ----- saving -----
  async function run(label, fn) {
    panel.classList.add("busy");
    try { await fn(); toast(label); await reload(sel); }
    catch (err) { toast(err.message || String(err), "error"); panel.classList.remove("busy"); }
  }

  async function movePaper(e, date, session) {
    const m = mod(e.moduleId);
    // 1. take it out of its halls (empty halls go, with their staff)
    for (const h of hallsOf(e.id)) {
      const mine = h.exams.find((x) => x.examId === e.id);
      await q(supabase.from("exam_halls").delete().eq("id", mine.id));
      if (h.exams.length === 1) await q(supabase.from("hall_sessions").delete().eq("id", h.id));
    }
    await q(supabase.from("exams").update({ exam_date: date, session, locked: true }).eq("id", e.id));
    // 2. find room in the new session: free halls, or spare seats in halls of the same intake
    const slotHalls = T.halls.filter((h) => h.date === date && h.session === session);
    const usedBy = Object.fromEntries(slotHalls.map((h) => [h.roomId, h]));
    const rooms = Object.values(T.roomById).filter((r) => !r.on_hold)
      .map((r) => ({ id: r.id, name: r.name, cap: r.exam_capacity - (usedBy[r.id] ? usedBy[r.id].exams.reduce((a, x) => a + x.seats, 0) : 0) }))
      .filter((r) => r.cap > 0);
    const batches = Object.fromEntries((T.batchesOf[m.id] || []).map((b) => [b, { intake: T.batchById[b]?.intake }]));
    const unit = { key: "x", modules: [{ id: m.id, code: m.code, students: T.moduleStudents[m.id] || 0 }], batchIds: T.batchesOf[m.id] || [], students: T.moduleStudents[m.id] || 0 };
    const res = allocate([unit], batches, rooms, { slots: [{ date, session }], place: new Map([["x", 0]]) });
    if (res.warnings.length) toast(res.warnings[0].text, "error");
    // 3. save halls; new halls get staff (least busy free people)
    for (const h of res.halls) {
      let hsId = usedBy[h.roomId]?.id;
      if (!hsId) {
        hsId = (await q(supabase.from("hall_sessions").insert({ period_id: periodId, exam_date: date, session, room_id: h.roomId }).select("id").single())).id;
        const n = h.exams.reduce((a, x) => a + x.seats, 0);
        const taken = new Set();
        for (const [role, k] of [["SUPERVISOR", 1], ["INVIGILATOR", n > T.threshold ? 2 : 1], ["ATTENDANT", 1]]) {
          const pick = candidates(T, date, session, role).filter((c) => !taken.has(c.s.id)).slice(0, k);
          for (const c of pick) {
            taken.add(c.s.id);
            await q(supabase.from("duties").insert({ hall_session_id: hsId, lecturer_id: c.s.id, role }));
          }
        }
      }
      for (const x of h.exams) await q(supabase.from("exam_halls").insert({ exam_id: e.id, hall_session_id: hsId, seats_used: x.seats }));
    }
  }

  async function replan() {
    const data = await loadAll();
    const o = T.period.options || {};
    const days = workingDays(T.period.start_date, T.period.end_date, data.holidays.map((h) => h.holiday_date));
    const moduleIds = new Set(T.exams.map((e) => e.moduleId));
    const mods = data.modules.filter((m) => moduleIds.has(m.id));
    const batchById = Object.fromEntries(data.batches.map((b) => [b.id, b]));
    const roomSet = new Set(o.rooms || data.rooms.map((r) => r.id));
    const staffSet = new Set(o.staff || data.staff.map((s) => s.id));
    const locked = T.exams.filter((e) => e.locked).map((e) => ({ moduleId: e.moduleId, date: e.date, session: e.session }));
    const lockedDuties = T.halls.flatMap((h) => h.duties.filter((d) => d.locked).map((d) => ({ date: h.date, session: h.session, roomId: h.roomId, staffId: d.staffId, role: d.role })));
    const input = buildInput({ mods, batchesOf: data.batchesOf, batchById, departments: data.departments,
      rooms: data.rooms.filter((r) => roomSet.has(r.id) && !r.on_hold), staff: data.staff.filter((s) => staffSet.has(s.id)),
      leave: data.leave, opts: { days, threshold: o.threshold ?? T.threshold, minGap: o.minGap ?? 1, seed: Date.now() % 100000 }, locked,
      availability: data.availability, responses: data.responses, limits: data.limits });
    input.lockedDuties = lockedDuties;
    const result = generate(input);
    // replace this timetable's papers, halls and duties (cascade removes halls' papers and duties)
    await q(supabase.from("exams").delete().eq("period_id", periodId));
    await q(supabase.from("hall_sessions").delete().eq("period_id", periodId));
    await saveTimetable(null, result, periodId);
    // keep the lock marks on the papers that were locked
    for (const l of locked) await q(supabase.from("exams").update({ locked: true }).eq("period_id", periodId).eq("module_id", l.moduleId));
    await q(supabase.from("exam_periods").update({ generated_at: new Date().toISOString() }).eq("id", periodId));
    const errs = result.warnings.filter((w) => w.level === "error").length;
    if (errs) toast(`Re-planned with ${errs} problem${errs > 1 ? "s" : ""} — see the health check.`, "error");
  }

  // Seats: index-number order, repeat students at the back
  async function allocateSeats() {
    const [students, repeats] = await Promise.all([
      q(supabase.from("students").select("index_no,batch_id,on_hold")),
      q(supabase.from("repeat_enrolments").select("*")),
    ]);
    if (!students.length) return { placed: 0, short: 0, none: true };
    const ehIds = T.halls.flatMap((h) => h.exams.map((x) => x.id));
    for (let i = 0; i < ehIds.length; i += 200)
      await q(supabase.from("seat_allocations").delete().in("exam_hall_id", ehIds.slice(i, i + 200)));
    // who sits in which hall
    const hallPeople = new Map();       // hall id -> [{ index_no, repeat, examHallId }]
    for (const e of T.exams) {
      const bs = new Set(T.batchesOf[e.moduleId] || []);
      const proper = students.filter((s) => !s.on_hold && bs.has(s.batch_id)).map((s) => s.index_no).sort();
      const rep = repeats.filter((r) => r.module_id === e.moduleId).map((r) => r.index_no).sort();
      const queue = [...proper.map((i) => ({ index_no: i, repeat: false })), ...rep.map((i) => ({ index_no: i, repeat: true }))];
      for (const h of hallsOf(e.id)) {
        const part = h.exams.find((x) => x.examId === e.id);
        const take = queue.splice(0, part.seats).map((p) => ({ ...p, examHallId: part.id }));
        (hallPeople.get(h.id) || hallPeople.set(h.id, []).get(h.id)).push(...take);
      }
    }
    const rows = [];
    let short = 0;
    for (const h of T.halls) {
      const people = (hallPeople.get(h.id) || []).sort((a, b) => a.repeat - b.repeat || a.index_no.localeCompare(b.index_no));
      const per = perRowOf(T.roomById[h.roomId] || { exam_capacity: h.cap });
      people.forEach((p, i) => {
        if (i >= h.cap) { short++; return; }
        rows.push({ exam_hall_id: p.examHallId, index_no: p.index_no, seat_label: seatLabel(Math.floor(i / per), i % per), is_repeat: p.repeat });
      });
    }
    for (let i = 0; i < rows.length; i += 500) await q(supabase.from("seat_allocations").insert(rows.slice(i, i + 500)));
    return { placed: rows.length, short };
  }

  // ----- events -----
  panel.addEventListener("click", async (ev) => {
    const t = ev.target.closest("[data-act],[data-add],[data-remove]");
    if (!t || t.matches("input")) return;
    const act = t.dataset.act;
    if (act === "back") { sel = null; onSelect(null); return draw(); }
    if (act === "move") {
      const v = panel.querySelector("#ep-slot").value;
      const e = examOf(sel.id);
      if (!v || v === `${e.date}|${e.session}`) return toast("Pick a different day or session first.", "error");
      const [d, s] = v.split("|");
      return run(`Moved to ${fmt(d)} ${s === "AM" ? "morning" : "afternoon"} and locked.`, () => movePaper(e, d, s));
    }
    if (act === "replan") {
      if (!confirm("Re-plan everything that is not locked? Unlocked papers may move to other days and staff may change.")) return;
      return run("Re-planned. Locked papers and duties were kept.", replan);
    }
    if (act === "unlock-all") return run("Everything unlocked.", async () => {
      await q(supabase.from("exams").update({ locked: false }).eq("period_id", periodId));
      const ids = T.halls.map((h) => h.id);
      for (let i = 0; i < ids.length; i += 200) await q(supabase.from("duties").update({ locked: false }).in("hall_session_id", ids.slice(i, i + 200)));
    });
    if (act === "publish" || act === "seats") {
      const errs = T.checks.filter((c) => c.level === "error").length;
      if (act === "publish" && errs && !confirm(`The health check still shows ${errs} problem${errs > 1 ? "s" : ""}. Publish anyway?`)) return;
      return run(act === "publish" ? "Published — lecturers and students can now see it." : "Seats re-allocated.", async () => {
        const r = await allocateSeats();
        if (r.none) toast("No students in the system yet, so no seat numbers were given. Halls and times are still published.");
        else if (r.short) toast(`${r.short} students could not get a seat — check hall capacities.`, "error");
        if (act === "publish") await q(supabase.from("exam_periods").update({ status: "published" }).eq("id", periodId));
      });
    }
    if (act === "unpublish") {
      if (!confirm("Unpublish? Lecturers and students will no longer see this timetable.")) return;
      return run("Unpublished — it's a draft again.", () => q(supabase.from("exam_periods").update({ status: "draft" }).eq("id", periodId)));
    }
    if (t.dataset.add) {
      const h = T.halls.find((x) => x.id === sel.id);
      const c = candidates(T, h.date, h.session, t.dataset.add)[0];
      if (!c) return toast(`Nobody free to be ${ROLE[t.dataset.add].toLowerCase()} in this session.`, "error");
      return run(`${name(c.s.id)} added as ${ROLE[t.dataset.add].toLowerCase()}.`, () =>
        q(supabase.from("duties").insert({ hall_session_id: h.id, lecturer_id: c.s.id, role: t.dataset.add, locked: true })));
    }
    if (t.dataset.remove) return run("Removed.", () => q(supabase.from("duties").delete().eq("id", Number(t.dataset.remove))));
  });
  panel.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (t.matches("[data-act=lock-exam]")) return run(t.checked ? "Paper locked." : "Paper unlocked.", () =>
      q(supabase.from("exams").update({ locked: t.checked }).eq("id", sel.id)));
    if (t.dataset.lockDuty) return run(t.checked ? "Duty locked." : "Duty unlocked.", () =>
      q(supabase.from("duties").update({ locked: t.checked }).eq("id", Number(t.dataset.lockDuty))));
    if (t.dataset.duty) return run(`Changed to ${name(Number(t.value))} (locked).`, () =>
      q(supabase.from("duties").update({ lecturer_id: Number(t.value), locked: true }).eq("id", Number(t.dataset.duty))));
  });

  // Carry out one suggestion from the AI assistant (checked beforehand by ai.js)
  async function applyAction(a) {
    if (a.type === "move") return movePaper(examOf(a.examId), a.date, a.session);
    if (a.type === "lock") return q(supabase.from("exams").update({ locked: true }).eq("id", a.examId));
    if (a.type === "replace") return q(supabase.from("duties").update({ lecturer_id: a.staffId, locked: true }).eq("id", a.dutyId));
    if (a.type === "add") return q(supabase.from("duties").insert({ hall_session_id: a.hallId, lecturer_id: a.staffId, role: a.role, locked: true }));
    if (a.type === "remove") return q(supabase.from("duties").delete().eq("id", a.dutyId));
    throw new Error("Unknown change.");
  }

  return {
    applyAction,
    select(type, id) { sel = type ? { type, id } : null; draw(); },
    get selection() { return sel; },
    draw,
  };
}
