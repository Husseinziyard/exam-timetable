// =====================================================================
// Shared code for the LECTURER and STUDENT pages:
// load a published timetable, draw a hall seat map, make PDFs.
// Only PUBLISHED timetables are shown here (never drafts).
// =====================================================================
import { supabase } from "./config.js";
import { withRepeats, cleanRepeats } from "./repeats.js";

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

// Which batches sat each paper of a timetable -> [{ module_id, batch_id }]
// (saved with the timetable, so old timetables stay right when the next intake sits the same papers)
export async function examLinks(exams) {
  const modOf = Object.fromEntries(exams.map((e) => [e.id, e.module_id]));
  const ids = exams.map((e) => e.id), out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const rows = await q(supabase.from("exam_batches").select("*").in("exam_id", ids.slice(i, i + 200)));
    rows.forEach((r) => out.push({ module_id: modOf[r.exam_id], batch_id: r.batch_id }));
  }
  return out;
}

// Published timetables, newest first
export async function publishedPeriods() {
  return q(supabase.from("exam_periods").select("*").eq("status", "published").order("start_date", { ascending: false }));
}

// Everything about one published timetable, joined up and easy to use
export async function loadPeriod(periodId) {
  const [period, exams, hallSessions, modules, batches, rooms, staff] = await Promise.all([
    q(supabase.from("exam_periods").select("*").eq("id", periodId).single()),
    q(supabase.from("exams").select("*").eq("period_id", periodId)),
    q(supabase.from("hall_sessions").select("*").eq("period_id", periodId)),
    q(supabase.from("modules").select("*")),
    q(supabase.from("batches").select("*")),
    q(supabase.from("rooms").select("*")),
    q(supabase.from("lecturers").select("id,title,full_name,grade")),
  ]);
  const links = await examLinks(exams);
  const hallIds = hallSessions.map((h) => h.id);
  const [examHalls, duties] = hallIds.length ? await Promise.all([
    q(supabase.from("exam_halls").select("*").in("hall_session_id", hallIds)),
    q(supabase.from("duties").select("*").in("hall_session_id", hallIds)),
  ]) : [[], []];

  const by = (arr, k = "id") => Object.fromEntries(arr.map((x) => [x[k], x]));
  const repeats = cleanRepeats(period.options?.repeats || []);
  const moduleById = by(withRepeats(modules, repeats)), batchById = by(batches), roomById = by(rooms), staffById = by(staff);
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
  // repeat students: how many per paper, and old papers that sit with a batch paper (shown in italics)
  const tight = (s) => String(s || "").toUpperCase().replace(/[\s-]/g, "");
  examList.forEach((e) => {
    e.repeats = Number(e.module.repeat_students) || 0;
    if (e.streams.length) return;
    const row = repeats.find((r) => tight(r.module_code) === tight(e.module.code));
    const host = row && examList.find((x) => x.streams.length && tight(x.module.code) === tight(row.sit_with) && x.date === e.date && x.session === e.session);
    if (host) { e.repeatOf = host; e.repStream = row.stream; }
    e.isRepeatPaper = true;
  });

  // fill in which papers each hall has
  halls.forEach((h) => h.papers.forEach((p) => { p.exam = examById[p.examId]; }));
  halls.sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || a.room.name.localeCompare(b.room.name, undefined, { numeric: true }));

  return { period, repeats, exams: examList, halls, hallById, examById, moduleById, batchById, roomById, staffById, batchesOf, name, batches, rooms, staff };
}

// =====================================================================
// HALL SEAT MAP (an SVG drawing)
//   room: { name, exam_capacity, seat_rows, seats_per_row, door_position }
//   used: how many seats are taken; highlight: a seat label like "C-07"
// =====================================================================
export function seatLabel(rowIndex, seatIndex) {
  return `${String.fromCharCode(65 + rowIndex)}-${String(seatIndex + 1).padStart(2, "0")}`;
}
// How many seats per row a hall has (used by the seat map AND by seat allocation, so they always agree)
export const perRowOf = (room) => room.seats_per_row || ((room.exam_capacity || 0) <= 40 ? 6 : 8);

export function seatMap(room, { used = 0, highlight = null, repeats = 0 } = {}) {
  const cap = room.exam_capacity || 0;
  const perRow = perRowOf(room);
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
// The PDF library + its table add-on, loaded the classic way (the add-on attaches itself to jsPDF)
export const PDF_LIBS = [
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
];
let pdfReady = null;
function loadScript(src) {
  return new Promise((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)?.dataset.loaded) return ok();
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => { el.dataset.loaded = "1"; ok(); };
    el.onerror = () => fail(new Error("Couldn't load the PDF tool. Check your internet connection and try again."));
    document.head.appendChild(el);
  });
}
async function loadPdfLibrary() {
  pdfReady ||= (async () => {
    if (!window.jspdf?.jsPDF) await loadScript(PDF_LIBS[0]);
    if (typeof window.jspdf.jsPDF.API.autoTable !== "function") await loadScript(PDF_LIBS[1]);
    if (typeof window.jspdf.jsPDF.API.autoTable !== "function") throw new Error("The PDF table tool didn't load. Please refresh the page and try again.");
    return window.jspdf.jsPDF;
  })().catch((e) => { pdfReady = null; throw e; });
  return pdfReady;
}

export async function downloadPdf({ title, subtitle = "", head, body, filename, landscape = true, sections = null }) {
  const jsPDF = await loadPdfLibrary();
  const doc = new jsPDF({ orientation: landscape ? "landscape" : "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 28;
  // one table, or several (e.g. one per batch, each on its own page)
  const parts = sections || [{ title, subtitle, head, body }];
  parts.forEach((part, i) => {
    if (i > 0) doc.addPage();
    const y = facultyHeading(doc, [FACULTY_NAME, part.title, part.subtitle ?? subtitle], M, W);
    doc.autoTable({
      head: [part.head], body: part.body.length ? part.body : [[{ content: "Nothing to show.", colSpan: part.head.length }]],
      startY: y + 4, theme: "grid", ...FACULTY_TABLE, margin: { left: M, right: M, bottom: 28 },
      styles: { ...FACULTY_TABLE.styles, fontSize: 9 },
    });
  });
  pageNumbers(doc, W, H);
  doc.save(filename);
}

// ----- the faculty look: Times, black grid, plain bold heading lines (underlined) -----
const FACULTY_TABLE = {
  styles: { font: "times", fontSize: 7.2, cellPadding: 2.5, textColor: 0, lineColor: [60, 60, 60], lineWidth: 0.5, valign: "top", overflow: "linebreak" },
  headStyles: { fillColor: [255, 255, 255], textColor: 0, fontStyle: "bold", halign: "center", valign: "middle" },
  rowPageBreak: "avoid", showHead: "everyPage",
};
function facultyHeading(doc, lines, M, W, y = 34) {
  doc.setTextColor(0); doc.setFont("times", "bold"); doc.setFontSize(10);
  lines.filter(Boolean).forEach((t) => {
    doc.splitTextToSize(String(t).toUpperCase(), W - 2 * M).forEach((w) => {
      doc.text(w, M, y); doc.setLineWidth(0.6); doc.line(M, y + 2, M + doc.getTextWidth(w), y + 2); y += 13;
    });
  });
  return y;
}
function pageNumbers(doc, W, H) {
  const n = doc.internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFillColor(255, 255, 255); doc.rect(W / 2 - 40, H - 24, 80, 14, "F");
    doc.setFontSize(7); doc.setTextColor(120); doc.setFont("times", "normal");
    doc.text(`Page ${i} of ${n}`, W / 2, H - 14, { align: "center" });
  }
}

// ----- Ready-made PDFs (used by the admin and lecturer pages) -----
const staffOf = (h, role) => h.duties.filter((d) => d.role === role).map((d) => d.name).join("\n");
const hallTime = (h) => h.papers.map((p) => p.exam?.time).filter(Boolean)[0] || (h.session === "AM" ? "09:00" : "13:00");
const batchLabel = (b) => `Intake ${b.intake} ${b.stream || b.degree}`;
const periodLine = (p) => p ? `${p.name} · ${fmtDate(p.start_date, { day: "numeric", month: "long" })} – ${fmtDate(p.end_date, { day: "numeric", month: "long", year: "numeric" })}` : "";

// Every hall session: where, when, which papers, who is on duty
export function hallRows(halls) {
  return halls.map((h) => [fmtDate(h.date, { weekday: "short", day: "2-digit", month: "short" }), hallTime(h), h.room.name,
    h.papers.map((p) => `${p.exam?.module.code} ${p.exam?.module.name}`).join("\n"),
    [...new Set(h.papers.flatMap((p) => p.exam?.streams.map(batchLabel) || []))].join(", "),
    String(h.students), staffOf(h, "SUPERVISOR"), staffOf(h, "INVIGILATOR"), staffOf(h, "ATTENDANT")]);
}
export const HALL_HEAD = ["Date", "Time", "Exam hall", "Papers", "Batches", "Students", "Supervisor", "Invigilators", "Hall attendant"];

export function pdfHalls(T, period, { title = "Exam timetable — halls and staff", halls = T.halls, note = "", filename = "exam-timetable.pdf" } = {}) {
  return downloadPdf({ title, subtitle: [periodLine(period), note].filter(Boolean).join(" · "), head: HALL_HEAD, body: hallRows(halls), filename });
}

// =====================================================================
// FACULTY SHEET — the "Supervisor / Invigilator list" in the faculty's usual layout:
// one block per week, rows grouped by day → session → intake → hall, with merged cells.
// =====================================================================
export const FACULTY_NAME = "FACULTY OF MANAGEMENT, SOCIAL SCIENCES & HUMANITIES";
const SESSION_TIME = { AM: "0900H - 1200H", PM: "1300H - 1600H" };
const ord = (n) => ["", "1ST", "2ND", "3RD"][n] || `${n}TH`;
const pad2 = (n) => String(n).padStart(2, "0");
const dmy = (iso) => iso.split("-").reverse().join(".");
const mondayOf = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

// Hall attendants are shown by initials: "Hall attendant FF" -> "FF", "Mr. KG Silva" -> "KGS"
export function shortName(name) {
  const n = String(name || "").replace(/^hall\s*attendant\s*/i, "").trim();
  if (n.length <= 4) return n.toUpperCase();
  const words = n.replace(/^(mr|mrs|ms|miss|dr|prof|rev)\.?\s+/i, "").replace(/\(.*?\)/g, "").trim().split(/\s+/);
  // a word that is already initials ("KG") is kept whole; other words give their first letter
  return words.map((w) => (/^[A-Z]{2,4}$/.test(w) ? w : w[0] || "")).join("").toUpperCase();
}

// Rows of the sheet for the given hall sessions (already filtered if needed)
export function facultyRows(T, halls) {
  const rows = [];
  const firstIntake = (h) => Math.max(...h.papers.flatMap((p) => p.exam?.streams.map((b) => b.intake) || [0]));
  const firstStream = (h) => h.papers.flatMap((p) => p.exam?.streams.map((b) => b.stream) || [""]).sort()[0] || "";
  const sorted = [...halls].sort((a, b) => a.date.localeCompare(b.date) || a.session.localeCompare(b.session) ||
    firstIntake(b) - firstIntake(a) || firstStream(a).localeCompare(firstStream(b)) || a.room.name.localeCompare(b.room.name, undefined, { numeric: true }));
  for (const h of sorted) {
    const staff = (r) => h.duties.filter((d) => d.role === r).map((d, i, all) => (all.length > 1 ? `${i + 1}. ` : "") + d.name).join("\n");
    const has = () => h.duties.filter((d) => d.role === "ATTENDANT").map((d) => shortName(d.name)).join("\n");
    const streamKey = (e) => (e?.streams[0]?.stream || e?.repStream || e?.repeatOf?.streams[0]?.stream || "") + (e?.isRepeatPaper ? "~" : "");
    const papers = [...h.papers].sort((a, b) => streamKey(a.exam).localeCompare(streamKey(b.exam)));
    for (const p of papers) {
      const e = p.exam; if (!e) continue;
      const m = e.module, bs = e.streams.length ? e.streams : (e.repeatOf?.streams || []);
      if (e.isRepeatPaper) {        // an old paper of repeat students, sitting with its batch's paper
        rows.push({
          date: h.date, session: h.session, hallId: h.id, italic: true,
          intake: [...new Set(bs.map((b) => b.intake))].join("/") || "—",
          sem: [...new Set(bs.map((b) => pad2(b.semester)))].join("/") || "—",
          streams: e.repStream || bs.map((b) => b.stream).join("\n") || "Repeat",
          subject: `${m.name}\n[${m.code}]\n[${pad2(m.duration_hours || 2)}hr Paper]`,
          stu: `R${pad2(p.seats)}`, count: pad2(p.seats), total: String(h.students), hall: h.room.name,
          sup: staff("SUPERVISOR"), inv: staff("INVIGILATOR"), ha: has(),
        });
        continue;
      }
      const rep = e.repeats || 0;
      const one = e.halls.length === 1;
      rows.push({
        date: h.date, session: h.session, hallId: h.id,
        intake: [...new Set(bs.map((b) => b.intake))].join("/"),
        sem: [...new Set(bs.map((b) => pad2(b.semester ?? m.semester)))].join("/"),
        streams: bs.map((b) => b.stream || b.degree).join("\n"),
        subject: `${m.name}\n[${m.code}]\n[${pad2(m.duration_hours || 3)} Hours]`,
        stu: one && rep ? `P${p.seats - rep} + R${pad2(rep)}` : `P${p.seats}`,
        count: String(p.seats), total: String(h.students), hall: h.room.name,
        sup: staff("SUPERVISOR"), inv: staff("INVIGILATOR"), ha: has(),
      });
    }
  }
  return rows;
}

export async function pdfFacultySheet(T, period, { halls = T.halls, note = "", highlight = null, filename = "exam-supervisor-invigilator-list.pdf" } = {}) {
  const jsPDF = await loadPdfLibrary();
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  drawFacultySheet(doc, T, period, { halls, note, highlight });
  facultyPageNumbers(doc);
  doc.save(filename);
}

// Draws the sheet into a document that may already have pages (several people in one file)
function drawFacultySheet(doc, T, period, { halls = T.halls, note = "", highlight = null } = {}) {
  const W = doc.internal.pageSize.getWidth(), M = 24;
  const all = facultyRows(T, halls);
  const intakes = [...new Set(all.flatMap((r) => r.intake.split("/")))].sort((a, b) => b - a);
  const sems = [...new Set(all.flatMap((r) => r.sem.split("/")))].sort().map(Number);
  const streams = [...new Set(all.flatMap((r) => r.streams.split("\n")))].sort();
  const weeks = [...new Set(all.map((r) => mondayOf(r.date)))].sort();
  const firstWeek = period?.start_date ? mondayOf(period.start_date) : weeks[0];
  const weekNo = (mon) => Math.round((new Date(mon) - new Date(firstWeek)) / 604800000) + 1;
  const head = [["DATE", "TIME", "INT.", "SEM.", "DEGREE PRO.", "SUBJECT/S", { content: "STU. ST.", colSpan: 3 }, "EX HALL", "SUPERVISOR", "INVIGILATOR", "HA"]];
  const footer = () => {
    doc.setFontSize(7); doc.setTextColor(120); doc.setFont("times", "normal");
    const n = doc.internal.getNumberOfPages();
    doc.text(`Page ${doc.internal.getCurrentPageInfo().pageNumber} of ${n}`, W / 2, doc.internal.pageSize.getHeight() - 14, { align: "center" });
  };
  if (!all.length) weeks.push(firstWeek);
  // a selection (one person, one batch…) runs on continuously; the full list starts each week on a new page
  const compact = halls !== T.halls;
  weeks.forEach((mon, wi) => {
    let y = 34;
    const rows = all.filter((r) => mondayOf(r.date) === mon);
    const last = rows.length ? rows[rows.length - 1].date : mon;
    const weekLine = `WEEK ${pad2(weekNo(mon))} (${dmy(rows[0]?.date || mon)} - ${dmy(last)})`;
    doc.setTextColor(0); doc.setFont("times", "bold"); doc.setFontSize(10);
    if (wi > 0 && compact && doc.lastAutoTable.finalY < doc.internal.pageSize.getHeight() - 140) {
      y = doc.lastAutoTable.finalY + 22;
      doc.text(weekLine, M, y); doc.line(M, y + 2, M + doc.getTextWidth(weekLine), y + 2); y += 13;
    } else {
    if (wi > 0) doc.addPage();
    // title block
    const lines = [FACULTY_NAME,
      `${sems.map(ord).join(" AND ")} SEMESTER EXAMINATIONS - INTAKE ${intakes.join(" & ")} ${period ? `(${period.name.toUpperCase()})` : ""}`.trim(),
      "SUPERVISOR / INVIGILATOR LIST",
      `${streams.join("/")} DEGREE PROGRAMMES`,
      weekLine];
    if (note) lines.splice(4, 0, note.toUpperCase());
    lines.forEach((t) => {
      const wrapped = doc.splitTextToSize(t, W - 2 * M);
      wrapped.forEach((w) => { doc.text(w, M, y); doc.line(M, y + 2, M + doc.getTextWidth(w), y + 2); y += 13; });
    });
    }
    // body with merged cells (rowSpan): date, time, intake/sem, and everything about a hall
    const body = [];
    const span = (i, key) => { let n = 1; while (i + n < rows.length && key(rows[i + n]) === key(rows[i])) n++; return n; };
    const startOf = (i, key) => i === 0 || key(rows[i - 1]) !== key(rows[i]);
    const kSes = (r) => r.date + r.session, kInt = (r) => r.date + r.session + r.intake + "|" + r.sem, kHall = (r) => r.hallId;
    rows.forEach((r, i) => {
      const row = [];
      const cell = (content, key, extra = {}) => { if (startOf(i, key)) row.push({ content, rowSpan: span(i, key), ...extra }); };
      cell(`${fmtDate(r.date, { day: "2-digit", month: "short" }).replace(" ", "-")}\n[${new Date(r.date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }).toUpperCase()}]`, kSes);
      cell(SESSION_TIME[r.session], kSes, { styles: { fillColor: [245, 205, 170], halign: "center" } });
      cell(r.intake, kInt, { styles: { fillColor: [245, 205, 170], halign: "center" } });
      cell(r.sem, kInt, { styles: { halign: "center" } });
      if (r.italic) row.push(r.streams, { content: r.subject, styles: { fontStyle: "italic" } }, r.stu, r.count);
      else row.push(r.streams, r.subject, r.stu, r.count);
      cell(r.total, kHall, { styles: { halign: "center", valign: "middle" } });
      cell(r.hall, kHall, { styles: { halign: "center", valign: "middle" } });
      // the person this sheet is for: their cell in bold on a light grey background
      const mine = (role) => highlight != null && T.hallById[r.hallId]?.duties.some((d) => d.staffId === highlight && d.role === role)
        ? { fontStyle: "bold", fillColor: [225, 225, 225] } : {};
      cell(r.sup, kHall, { styles: mine("SUPERVISOR") }); cell(r.inv, kHall, { styles: mine("INVIGILATOR") });
      cell(r.ha, kHall, { styles: { halign: "center", ...mine("ATTENDANT") } });
      body.push(row);
    });
    doc.autoTable({
      head, body: body.length ? body : [[{ content: "No exams this week.", colSpan: 13 }]], startY: y + 4, theme: "grid",
      margin: { left: M, right: M, bottom: 28 }, rowPageBreak: "avoid", showHead: "everyPage",
      styles: { font: "times", fontSize: 7.2, cellPadding: 2.5, textColor: 0, lineColor: [60, 60, 60], lineWidth: 0.5, valign: "top", overflow: "linebreak" },
      headStyles: { fillColor: [255, 255, 255], textColor: 0, fontStyle: "bold", halign: "center", valign: "middle" },
      columnStyles: { 0: { cellWidth: 46 }, 1: { cellWidth: 38 }, 2: { cellWidth: 20 }, 3: { cellWidth: 20 }, 4: { cellWidth: 38 },
        5: { cellWidth: 112 }, 6: { cellWidth: 34 }, 7: { cellWidth: 20, halign: "center" }, 8: { cellWidth: 22 }, 9: { cellWidth: 28 },
        10: { cellWidth: 66 }, 11: { cellWidth: 66 }, 12: { cellWidth: 27 } },
      didDrawPage: footer,
    });
  });
  // closing block on the last page: notes, signature, distribution
  let y = doc.lastAutoTable.finalY + 22;
  if (y > doc.internal.pageSize.getHeight() - 150) { doc.addPage(); y = 50; }
  doc.setFont("times", "bold"); doc.setFontSize(8.5); doc.setTextColor(0);
  doc.text("NOTES -", M, y);
  doc.text("# P = STUDENTS OF THE BATCH, R = REPEAT STUDENTS. PAPER DURATION IS SHOWN UNDER EACH SUBJECT.", M + 60, y);
  doc.text("# PLEASE REPORT TO THE EXAMINATION HALL 30 MINUTES BEFORE THE SESSION STARTS.", M + 60, y + 13);
  y += 58;
  doc.setFont("times", "normal"); doc.text("................................................", M, y);
  doc.setFont("times", "bold"); doc.text("Dean - FMSH", M, y + 13);
  doc.setFont("times", "normal");
  // hall attendants key: initials -> full name
  const haNames = [...new Set(halls.flatMap((h) => h.duties.filter((d) => d.role === "ATTENDANT").map((d) => d.name)))]
    .filter((n) => shortName(n) !== n).sort((a, b) => shortName(a).localeCompare(shortName(b)));
  if (haNames.length) {
    doc.setFont("times", "bold"); doc.text("HALL ATTENDANTS -", W / 2 + 20, y + 40);
    doc.setFont("times", "normal");
    haNames.forEach((n, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      doc.text(`${shortName(n)} - ${n}`, W / 2 + 20 + col * 125, y + 54 + row * 11);
    });
  }
  doc.setFont("times", "normal");
  doc.text("Distribution  -", M, y + 40);
  ["All HoDs - FMSH", "All Supervisors & Invigilators", "All Hall Attendants", "DR - Examinations"].forEach((t, i) => doc.text(t, M + 90, y + 40 + i * 12));
}

// fix "Page x of y" now that we know the total
function facultyPageNumbers(doc) {
  const W = doc.internal.pageSize.getWidth(), n = doc.internal.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i); doc.setFillColor(255, 255, 255);
    doc.rect(W / 2 - 40, doc.internal.pageSize.getHeight() - 24, 80, 14, "F");
    doc.setFontSize(7); doc.setTextColor(120); doc.setFont("times", "normal");
    doc.text(`Page ${i} of ${n}`, W / 2, doc.internal.pageSize.getHeight() - 14, { align: "center" });
  }
}

// One batch (or several, one page each): the timetable to email to students
export function batchRows(T, batchId) {
  return T.exams.filter((e) => e.streams.some((b) => b.id === Number(batchId)))
    .map((e) => [fmtDate(e.date, { weekday: "long", day: "numeric", month: "long" }), e.time, e.module.code, e.module.name,
      e.halls.map((x) => x.hall.room.name).join(", ") || "—"]);
}
// Batch timetables in the faculty look: heading block, one block per week, merged date cells, Dean's line.
// One batch per page (several batches → several pages).
const hhmm = (t) => String(t || "").split(/[–-]/).map((x) => x.trim().replace(":", "") + "H").join(" - ");
export async function pdfBatches(T, period, batchIds, filename = "batch-timetables.pdf") {
  const jsPDF = await loadPdfLibrary();
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 34;
  const firstWeek = period?.start_date ? mondayOf(period.start_date) : null;
  const head = [["DATE", "TIME", "MODULE CODE", "SUBJECT", "NO. OF STU.", "EXAM HALL/S"]];
  const underline = (t, y) => { doc.text(t, M, y); doc.setLineWidth(0.6); doc.line(M, y + 2, M + doc.getTextWidth(t), y + 2); };
  batchIds.forEach((id, bi) => {
    const b = T.batchById[id];
    if (bi > 0) doc.addPage();
    const exams = T.exams.filter((e) => e.streams.some((x) => x.id === Number(id)));
    doc.setTextColor(0); doc.setFont("times", "bold"); doc.setFontSize(10);
    let y = 40;
    [FACULTY_NAME,
      `${ord(Number(b.semester))} SEMESTER EXAMINATIONS - INTAKE ${b.intake}${period ? ` (${period.name.toUpperCase()})` : ""}`,
      "EXAMINATION TIMETABLE",
      `${String(b.stream || b.degree).toUpperCase()} DEGREE PROGRAMME`,
    ].forEach((t) => doc.splitTextToSize(t, W - 2 * M).forEach((w) => { underline(w, y); y += 14; }));
    const weeks = [...new Set(exams.map((e) => mondayOf(e.date)))].sort();
    if (!weeks.length) {
      doc.autoTable({ head, body: [[{ content: "No exams for this batch in this timetable.", colSpan: 6 }]], startY: y + 6, theme: "grid", ...FACULTY_TABLE, margin: { left: M, right: M } });
    }
    const fw = firstWeek || weeks[0];
    weeks.forEach((mon, wi) => {
      const rows = exams.filter((e) => mondayOf(e.date) === mon);
      y = wi === 0 ? y + 4 : doc.lastAutoTable.finalY + 20;
      if (y > H - 120) { doc.addPage(); y = 44; }
      const weekNo = Math.round((new Date(mon) - new Date(fw)) / 604800000) + 1;
      doc.setFont("times", "bold"); doc.setFontSize(10);
      underline(`WEEK ${pad2(weekNo)} (${dmy(rows[0].date)} - ${dmy(rows[rows.length - 1].date)})`, y);
      const body = rows.map((e, i) => {
        const row = [];
        if (i === 0 || rows[i - 1].date !== e.date) {
          let n = 1; while (i + n < rows.length && rows[i + n].date === e.date) n++;
          row.push({ content: `${fmtDate(e.date, { day: "2-digit", month: "short" }).replace(" ", "-")}\n[${new Date(e.date + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" }).toUpperCase()}]`, rowSpan: n });
        }
        const seats = e.halls.reduce((a, x) => a + x.seats, 0);
        row.push({ content: hhmm(e.time), styles: { fillColor: [245, 205, 170], halign: "center" } },
          e.module.code, `${e.module.name}\n[${pad2(e.module.duration_hours || 3)} Hours]`,
          { content: String(seats || "—"), styles: { halign: "center" } },
          e.halls.map((x) => x.hall.room.name).join(", ") || "—");
        return row;
      });
      doc.autoTable({
        head, body, startY: y + 6, theme: "grid", ...FACULTY_TABLE, margin: { left: M, right: M, bottom: 30 },
        styles: { ...FACULTY_TABLE.styles, fontSize: 9, cellPadding: 3.5 },
        columnStyles: { 0: { cellWidth: 82 }, 1: { cellWidth: 74 }, 2: { cellWidth: 74 }, 4: { cellWidth: 46 }, 5: { cellWidth: 88 } },
      });
    });
    // closing: notes and Dean's line
    y = (doc.lastAutoTable?.finalY || y) + 26;
    if (y > H - 90) { doc.addPage(); y = 50; }
    doc.setFont("times", "bold"); doc.setFontSize(9);
    doc.text("NOTES -", M, y);
    doc.text("# TIMES SHOWN ARE THE START AND END OF EACH PAPER.", M + 50, y);
    doc.text("# WHERE MORE THAN ONE HALL IS SHOWN, THE BATCH IS SHARED BETWEEN THOSE HALLS.", M + 50, y + 12);
    y += 52;
    doc.setFont("times", "normal"); doc.text("................................................", M, y);
    doc.setFont("times", "bold"); doc.text("Dean - FMSH", M, y + 13);
  });
  pageNumbers(doc, W, H);
  doc.save(filename);
}
// The batches that sit something in this timetable, newest intake first
export function timetableBatches(T) {
  return [...new Map(T.exams.flatMap((e) => e.streams.map((b) => [b.id, b]))).values()]
    .sort((a, b) => b.intake - a.intake || String(a.stream).localeCompare(String(b.stream)));
}

// One person's duties: where they must be, when, and with whom
export function pdfStaff(T, period, staffId, name) {
  const hs = T.halls.filter((h) => h.duties.some((d) => d.staffId === staffId));
  return pdfFacultySheet(T, period, { halls: hs, note: `Duties of ${name} (${hs.length} dut${hs.length === 1 ? "y" : "ies"})`,
    highlight: staffId, filename: `exam-duties-${name.replace(/\W+/g, "-").toLowerCase()}.pdf` });
}

// Duty list for every staff member (one page each) — handy for the exam office
export async function pdfAllStaff(T, period) {
  const ids = [...new Set(T.halls.flatMap((h) => h.duties.map((d) => d.staffId)))]
    .sort((a, b) => T.name(a).localeCompare(T.name(b)));
  const jsPDF = await loadPdfLibrary();
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  ids.forEach((id, i) => {
    if (i > 0) doc.addPage();       // each person starts on a new page
    const hs = T.halls.filter((h) => h.duties.some((d) => d.staffId === id));
    drawFacultySheet(doc, T, period, { halls: hs, highlight: id,
      note: `Duties of ${T.name(id)} (${hs.length} dut${hs.length === 1 ? "y" : "ies"})` });
  });
  facultyPageNumbers(doc);
  doc.save("staff-duty-lists.pdf");
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

// A hall's full picture: papers and staff
export function hallDetailsHtml(T, h, { myStaffId = null } = {}) {
  const papers = h.papers.map((p) => `<li><b>${esc(p.exam?.module.code)}</b> ${esc(p.exam?.module.name)}
      <span class="muted">· ${p.exam?.streams.map((b) => `Intake ${b.intake} ${esc(b.stream)}`).join(", ")} · ${p.seats} students</span></li>`).join("");
  const staff = ["SUPERVISOR", "INVIGILATOR", "ATTENDANT"].map((r) => h.duties.filter((d) => d.role === r)
    .map((d) => `<li><span class="role">${ROLE_NAMES[r]}</span> ${esc(d.name)}${d.staffId === myStaffId ? ' <span class="badge active">You</span>' : ""}</li>`).join("")).join("");
  return `
    <div class="hall-detail one">
      <p class="muted">${fmtDate(h.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} · ${h.session === "AM" ? "Morning" : "Afternoon"} · ${h.students} students${h.room.building ? ` · ${esc(h.room.building)}` : ""}</p>
      <h3 class="gen-h">Papers in this hall</h3><ul class="plain">${papers}</ul>
      <h3 class="gen-h">Staff</h3><ul class="plain staff-list">${staff || "<li class='muted'>Not assigned yet.</li>"}</ul>
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
