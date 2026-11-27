// Editing a published timetable safely.
//
// A published timetable is the "live" version that lecturers and students see.
// To change it, the admin makes a DRAFT COPY, edits the copy, then REPUBLISHES:
// the copy becomes the live version and the old one is removed.
// Until then, everyone keeps seeing the old version.
//
// The link between the copy and the live version is kept in exam_periods.options.replaces
// (no database change needed).
import { supabase } from "./config.js";

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };
const chunks = (arr, n = 200) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// The draft copy of a live timetable that is already being worked on (if any)
export async function findDraftCopy(liveId) {
  const drafts = await q(supabase.from("exam_periods").select("*").eq("status", "draft"));
  return drafts.find((d) => Number(d.options?.replaces) === Number(liveId)) || null;
}

// Make a full draft copy: papers, halls, staff duties and locks (seats are given again on republish)
export async function copyPeriod(liveId) {
  const live = await q(supabase.from("exam_periods").select("*").eq("id", liveId).single());
  const copy = await q(supabase.from("exam_periods").insert({
    name: live.name, start_date: live.start_date, end_date: live.end_date, status: "draft",
    options: { ...(live.options || {}), replaces: live.id }, generated_at: live.generated_at,
  }).select("id").single());
  try {
    const exams = await q(supabase.from("exams").select("*").eq("period_id", liveId));
    const halls = await q(supabase.from("hall_sessions").select("*").eq("period_id", liveId));
    const hallIds = halls.map((h) => h.id);
    const examHalls = [], duties = [];
    for (const ids of chunks(hallIds)) {
      examHalls.push(...await q(supabase.from("exam_halls").select("*").in("hall_session_id", ids)));
      duties.push(...await q(supabase.from("duties").select("*").in("hall_session_id", ids)));
    }

    // papers (one per module in a timetable)
    const newExams = exams.length ? await q(supabase.from("exams").insert(exams.map((e) => ({
      period_id: copy.id, module_id: e.module_id, exam_date: e.exam_date, session: e.session, locked: e.locked,
    }))).select("id,module_id")) : [];
    const byModule = Object.fromEntries(newExams.map((e) => [e.module_id, e.id]));
    const examMap = Object.fromEntries(exams.map((e) => [e.id, byModule[e.module_id]]));
    // which batches sat each paper
    const oldIds = exams.map((e) => e.id), links = [];
    for (const ids of chunks(oldIds)) links.push(...await q(supabase.from("exam_batches").select("*").in("exam_id", ids)));
    for (const part of chunks(links, 500)) await q(supabase.from("exam_batches").insert(part.map((l) => ({ exam_id: examMap[l.exam_id], batch_id: l.batch_id }))));

    // halls (one per room, date and session)
    const key = (h) => `${h.exam_date}|${h.session}|${h.room_id}`;
    const newHalls = halls.length ? await q(supabase.from("hall_sessions").insert(halls.map((h) => ({
      period_id: copy.id, exam_date: h.exam_date, session: h.session, room_id: h.room_id, locked: h.locked,
    }))).select("id,exam_date,session,room_id")) : [];
    const byKey = Object.fromEntries(newHalls.map((h) => [key(h), h.id]));
    const hallMap = Object.fromEntries(halls.map((h) => [h.id, byKey[key(h)]]));

    for (const part of chunks(examHalls)) await q(supabase.from("exam_halls").insert(part.map((x) => ({
      exam_id: examMap[x.exam_id], hall_session_id: hallMap[x.hall_session_id], seats_used: x.seats_used,
    }))));
    for (const part of chunks(duties)) await q(supabase.from("duties").insert(part.map((d) => ({
      hall_session_id: hallMap[d.hall_session_id], lecturer_id: d.lecturer_id, role: d.role, locked: d.locked,
    }))));
    return copy.id;
  } catch (err) {
    await supabase.from("exam_periods").delete().eq("id", copy.id);   // don't leave a half copy behind
    throw err;
  }
}

// Make the draft copy the live version and remove the old live version
export async function republish(period) {
  const oldId = period.options?.replaces;
  const options = { ...(period.options || {}), published_at: new Date().toISOString() };
  delete options.replaces;
  await q(supabase.from("exam_periods").update({ status: "published", options }).eq("id", period.id));
  if (oldId) await q(supabase.from("exam_periods").delete().eq("id", oldId));
}

// Publish a draft for the first time (or again after Unpublish)
export async function publishPeriod(period) {
  const options = { ...(period.options || {}), published_at: new Date().toISOString() };
  await q(supabase.from("exam_periods").update({ status: "published", options }).eq("id", period.id));
  period.status = "published"; period.options = options;
}

// Email every lecturer that the schedule is out (again = it was republished).
// Returns { sent } or throws with a plain message.
export async function announceRelease(periodId, again = false) {
  const site = new URL(".", location.href).href;
  const { data, error } = await supabase.functions.invoke("send-mail", { body: { kind: "released", period_id: periodId, again, site } });
  if (error) {
    let m = error.message;
    try { m = (await error.context?.json())?.error || m; } catch {}
    throw new Error(m);
  }
  if (data?.error) throw new Error(data.error);
  return data || {};
}

// Delete any timetable (draft or published). Everything inside it goes too.
export async function deletePeriod(id) {
  await q(supabase.from("exam_periods").delete().eq("id", id));
}

// Ask before deleting. Published ones need the word DELETE typed in.
export function confirmDelete(period) {
  if (period.status !== "published") return confirm(`Delete the draft “${period.name}”? This cannot be undone.`);
  const typed = prompt(`“${period.name}” is PUBLISHED. Lecturers will no longer see it, and all its halls and duties are deleted.\n\nType DELETE to confirm.`);
  return typed?.trim().toUpperCase() === "DELETE";
}
