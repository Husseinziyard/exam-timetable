// =====================================================================
// Shared code for the LECTURER and STUDENT pages:
// load a published timetable, draw a hall seat map, make PDFs.
// Only PUBLISHED timetables are shown here (never drafts).
// =====================================================================
import { supabase } from "./config.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtDate = (s, opts = { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const ROLE_NAMES = { SUPERVISOR: "Supervisor", INVIGILATOR: "Invigilator", ATTENDANT: "Hall attendant" };
const START = { AM: 9, PM: 13 };
export function timeLabel(session, hours = 3) {
  const s = START[session], e = s + Number(hours || 3);
  const f = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;
  return `${f(s)}–${f(e)}`;
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

// Published timetables, newest first
export async function publishedPeriods() {
  return q(supabase.from("exam_periods").select("*").eq("status", "published").order("start_date", { ascending: false }));
}

// Everything about one published timetable, joined up and easy to use
export async function loadPeriod(periodId) {
  const [exams, hallSessions, modules, links, batches, rooms, staff] = await Promise.all([
    q(supabase.from("exams").select("*").eq("period_id", periodId)),
    q(supabase.from("hall_sessions").select("*").eq("period_id", periodId)),
    q(supabase.from("modules").select("*")),
    q(supabase.from("module_batches").select("*")),
    q(supabase.from("batches").select("*")),
    q(supabase.from("rooms").select("*")),
    q(supabase.from("lecturers").select("id,title,full_name,grade")),
  ]);
  const hallIds = hallSessions.map((h) => h.id);
  const [examHalls, duties] = hallIds.length ? await Promise.all([
    q(supabase.from("exam_halls").select("*").in("hall_session_id", hallIds)),
    q(supabase.from("duties").select("*").in("hall_session_id", hallIds)),
  ]) : [[], []];

  const by = (arr, k = "id") => Object.fromEntries(arr.map((x) => [x[k], x]));
  const moduleById = by(modules), batchById = by(batches), roomById = by(rooms), staffById = by(staff);
  const batchesOf = {};
  links.forEach((l) => (batchesOf[l.module_id] ||= []).push(l.batch_id));
  const name = (id) => { const s = staffById[id]; return s ? `${s.title ? s.title + " " : ""}${s.full_name}` : "—"; };

  const halls = hallSessions.map((h) => {
    const room = roomById[h.room_id] || { name: "?", exam_capacity: 0 };
    const hd = duties.filter((d) => d.hall_session_id === h.id);
    const papers = examHalls.filter((x) => x.hall_session_id === h.id);
    return {
      id: h.id, date: h.exam_date, session: h.session, room,
      students: papers.reduce((a, x) => a + x.seats_used, 0),
      papers: papers.map((x) => ({ examHallId: x.id, examId: x.exam_id, seats: x.seats_used })),
      duties: hd.map((d) => ({ staffId: d.lecturer_id, role: d.role, name: name(d.lecturer_id) })),
    };
  });
  const hallById = by(halls);

  const examList = exams.map((e) => {
    const m = moduleById[e.module_id] || { code: "?", name: "?" };
    const inHalls = halls.filter((h) => h.papers.some((p) => p.examId === e.id))
      .map((h) => ({ hall: h, seats: h.papers.find((p) => p.examId === e.id).seats }));
    return {
      id: e.id, date: e.exam_date, session: e.session, module: m,
      time: timeLabel(e.session, m.duration_hours),
      streams: (batchesOf[m.id] || []).map((b) => batchById[b]).filter(Boolean),
      halls: inHalls,
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || a.module.code.localeCompare(b.module.code));
  const examById = by(examList);

  // fill in which papers each hall has
  halls.forEach((h) => h.papers.forEach((p) => { p.exam = examById[p.examId]; }));
  halls.sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || a.room.name.localeCompare(b.room.name, undefined, { numeric: true }));

  return { exams: examList, halls, hallById, examById, moduleById, batchById, roomById, staffById, batchesOf, name, batches, rooms, staff };
}

// =====================================================================
// HALL SEAT MAP (an SVG drawing)
//   room: { name, exam_capacity, seat_rows, seats_per_row, door_position }
//   used: how many seats are taken; highlight: a seat label like "C-07"
// =====================================================================
export function seatLabel(rowIndex, seatIndex) {
  return `${String.fromCharCode(65 + rowIndex)}-${String(seatIndex + 1).padStart(2, "0")}`;
}
export function seatMap(room, { used = 0, highlight = null, repeats = 0 } = {}) {
  const cap = room.exam_capacity || 0;
  const perRow = room.seats_per_row || (cap <= 40 ? 6 : 8);
  const rows = room.seat_rows || Math.max(1, Math.ceil(cap / perRow));
  const S = 30, G = 8, aisleAfter = perRow > 4 ? Math.ceil(perRow / 2) : 99, AISLE = 18;
  const left = 46, top = 78;
  const width = left + perRow * (S + G) + (perRow > aisleAfter ? AISLE : 0) + 30;
  const height = top + rows * (S + G) + 30;
  const door = room.door_position || "front-left";
  const parts = [];
  // front wall with the lecturer's desk
  parts.push(`<rect x="${width / 2 - 80}" y="14" width="160" height="30" rx="6" class="desk"/>`);
  parts.push(`<text x="${width / 2}" y="34" text-anchor="middle" class="desk-t">Lecturer’s desk · front</text>`);
  // door
  const dx = door.endsWith("left") ? 6 : width - 36;
  const dy = door.startsWith("front") ? 14 : height - 44;
  parts.push(`<rect x="${dx}" y="${dy}" width="30" height="30" rx="4" class="door"/><text x="${dx + 15}" y="${dy + 19}" text-anchor="middle" class="door-t">Door</text>`);
  // seats: filled from the front by index order; repeat students take the last seats (at the back)
  let n = 0;
  for (let r = 0; r < rows; r++) {
    const y = top + r * (S + G);
    parts.push(`<text x="${left - 14}" y="${y + 20}" text-anchor="middle" class="row-t">${String.fromCharCode(65 + r)}</text>`);
    for (let c = 0; c < perRow; c++) {
      if (n >= cap) break;
      const x = left + c * (S + G) + (c >= aisleAfter ? AISLE : 0);
      const label = seatLabel(r, c);
      const taken = n < used;
      const repeat = taken && n >= used - repeats;
      const cls = label === highlight ? "seat me" : repeat ? "seat rep" : taken ? "seat on" : "seat";
      parts.push(`<g><title>${label}${label === highlight ? " (your seat)" : ""}</title><rect x="${x}" y="${y}" width="${S}" height="${S}" rx="6" class="${cls}"/>
        <text x="${x + S / 2}" y="${y + 19}" text-anchor="middle" class="seat-t">${c + 1}</text></g>`);
      n++;
    }
  }
  return `<svg class="seatmap" viewBox="0 0 ${width} ${height}" role="img" aria-label="Seat plan of ${esc(room.name)}: ${rows} rows, ${cap} seats, ${used} taken">${parts.join("")}</svg>`;
}

// =====================================================================
// PDF (made in the browser — nothing is sent anywhere)
// =====================================================================
export async function downloadPdf({ title, subtitle = "", head, body, filename, landscape = true }) {
  const { jsPDF } = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
  const { default: autoTable } = await import("https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/+esm");
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: "a4" });
  doc.setFontSize(16); doc.setFont("helvetica", "bold");
  doc.text(title, 40, 46);
  doc.setFontSize(10); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
  if (subtitle) doc.text(subtitle, 40, 64);
  autoTable(doc, {
    head: [head], body, startY: subtitle ? 80 : 64,
    styles: { fontSize: 9, cellPadding: 5, valign: "top" },
    headStyles: { fillColor: [19, 32, 58], textColor: 245 },
    alternateRowStyles: { fillColor: [247, 246, 242] },
    margin: { left: 40, right: 40 },
    didDrawPage: () => {
      doc.setFontSize(8); doc.setTextColor(140);
      doc.text(`Exam Timetable System · generated ${new Date().toLocaleString("en-GB")}`, 40, doc.internal.pageSize.getHeight() - 20);
    },
  });
  doc.save(filename);
}

// =====================================================================
// Details pop-up
// =====================================================================
export function details(html) {
  const dlg = document.createElement("dialog");
  dlg.className = "form-dialog detail-dialog";
  dlg.innerHTML = `<div class="detail">${html}<div class="dialog-actions"><button class="btn" value="close">Close</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.showModal();
  dlg.querySelector('[value="close"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  return dlg;
}

// A hall's full picture: papers, staff, seat map
export function hallDetailsHtml(T, h, { myStaffId = null, highlight = null, examId = null } = {}) {
  const papers = h.papers.map((p) => `<li><b>${esc(p.exam?.module.code)}</b> ${esc(p.exam?.module.name)}
      <span class="muted">· ${p.exam?.streams.map((b) => `Intake ${b.intake} ${esc(b.stream)}`).join(", ")} · ${p.seats} students</span></li>`).join("");
  const staff = ["SUPERVISOR", "INVIGILATOR", "ATTENDANT"].map((r) => h.duties.filter((d) => d.role === r)
    .map((d) => `<li><span class="role">${ROLE_NAMES[r]}</span> ${esc(d.name)}${d.staffId === myStaffId ? ' <span class="badge active">You</span>' : ""}</li>`).join("")).join("");
  const thisPaper = examId ? h.papers.find((p) => p.examId === examId) : null;
  return `
    <div class="hall-detail">
      <div>
        <p class="muted">${fmtDate(h.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${h.session === "AM" ? "Morning" : "Afternoon"}</p>
        <h3 class="gen-h">Papers in this hall</h3><ul class="plain">${papers}</ul>
        <h3 class="gen-h">Staff</h3><ul class="plain staff-list">${staff || "<li class='muted'>Not assigned yet.</li>"}</ul>
        ${thisPaper && !highlight ? `<p class="muted small">Seat numbers are shown once seats are allocated.</p>` : ""}
      </div>
      <div class="map-box">
        ${seatMap(h.room, { used: h.students, highlight })}
        <p class="legend small"><span class="key on"></span> taken <span class="key"></span> empty ${highlight ? '<span class="key me"></span> your seat' : ""}</p>
      </div>
    </div>`;
}

// Fills in the "Timetable" dropdown; returns the chosen period id
export function periodPicker(select, periods, onChange) {
  select.innerHTML = periods.map((p) => `<option value="${p.id}">${esc(p.name)} (${fmtDate(p.start_date, { day: "numeric", month: "short" })} – ${fmtDate(p.end_date, { day: "numeric", month: "short", year: "numeric" })})</option>`).join("");
  const wrap = select.closest("label") || select;
  wrap.hidden = periods.length < 2;      // only show the picker when there is a choice
  select.addEventListener("change", () => onChange(Number(select.value)));
  return periods[0]?.id;
}
