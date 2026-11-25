// =====================================================================
// AVAILABILITY — "when can't you come for exam duties?"
//   • the form (used by lecturers on their page, and by the admin)
//   • the admin page: send a request, see who answered, import Google Form answers
// The generator never gives a duty in a session someone can't come to.
// =====================================================================
import { supabase } from "./config.js";
import { workingDays } from "./engine.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s, o = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const CHOICES = [["", "Available"], ["AM", "Morning off"], ["PM", "Afternoon off"], ["ALL", "Whole day off"]];
const PREFS = [["any", "No preference"], ["AM", "Mornings"], ["PM", "Afternoons"]];
const GRADE = { PROF: "Professor", SL1: "SL Gr. I", SL2: "SL Gr. II", LECT: "Lecturer", INSTR: "Instructor", MIL: "Military", HA: "Hall attendant" };

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
function flash(text, kind = "ok") {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = `toast ${kind}`; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4500);
}

export async function roundDays(round) {
  const hol = await q(supabase.from("holidays").select("holiday_date"));
  return workingDays(round.start_date, round.end_date, hol.map((h) => h.holiday_date));
}

// Short text: "18 Nov (all day), 19 Nov morning"
export function summarise(rows) {
  const word = { ALL: "all day", AM: "morning", PM: "afternoon" };
  return [...rows].sort((a, b) => a.unavailable_date.localeCompare(b.unavailable_date))
    .map((r) => `${fmt(r.unavailable_date, { day: "numeric", month: "short" })} ${r.session === "ALL" ? "(all day)" : word[r.session]}`).join(", ");
}

// =====================================================================
// THE FORM
// =====================================================================
export function availabilityForm({ container, round, days, existing = [], preference = "any", readOnly = false, onSave, saveLabel = "Send my availability" }) {
  const chosen = Object.fromEntries(existing.map((r) => [r.unavailable_date, r.session]));
  // group the days by week so the form is easy to scan
  const weeks = [];
  days.forEach((d) => {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    if (!weeks.length || wd === 1 || weeks[weeks.length - 1].length === 0) weeks.push([]);
    weeks[weeks.length - 1].push(d);
  });
  container.innerHTML = `
    <form class="av-form">
      ${readOnly ? `<p class="msg show ok">This request is closed, so answers can't be changed any more.</p>` : ""}
      <div class="av-tools">
        <p class="small muted">Everything is <b>available</b> unless you change it. Mark only the days or sessions you <b>can't</b> come.</p>
        ${readOnly ? "" : `<button type="button" class="link" data-reset>Mark all available</button>`}
      </div>
      ${weeks.map((w) => `<fieldset class="av-week"><legend>Week of ${fmt(w[0], { day: "numeric", month: "long" })}</legend>
        ${w.map((d) => `<div class="av-day ${chosen[d] ? "has-off" : ""}">
          <span class="av-date">${fmt(d)}</span>
          <div class="seg" role="radiogroup" aria-label="${fmt(d, { weekday: "long", day: "numeric", month: "long" })}">
            ${CHOICES.map(([v, l]) => `<label class="${v ? "off" : "yes"}"><input type="radio" name="d-${d}" value="${v}" ${(chosen[d] || "") === v ? "checked" : ""} ${readOnly ? "disabled" : ""}><span>${l}</span></label>`).join("")}
          </div>
        </div>`).join("")}
      </fieldset>`).join("")}
      <fieldset class="av-pref"><legend>Do you prefer a session?</legend>
        <div class="seg" role="radiogroup">${PREFS.map(([v, l]) => `<label class="yes"><input type="radio" name="pref" value="${v}" ${preference === v ? "checked" : ""} ${readOnly ? "disabled" : ""}><span>${l}</span></label>`).join("")}</div>
        <p class="small muted">A preference is followed when possible; the days you can't come are always respected.</p>
      </fieldset>
      <p class="av-count small"></p>
      ${readOnly ? "" : `<button class="btn big" type="submit">${esc(saveLabel)}</button>`}
    </form>`;
  const form = container.querySelector("form");
  const count = () => {
    const n = days.filter((d) => form.querySelector(`[name="d-${d}"]:checked`)?.value).length;
    container.querySelector(".av-count").textContent = n ? `${n} day${n > 1 ? "s" : ""} with times you can't come.` : "You're available on every exam day.";
    days.forEach((d) => form.querySelector(`[name="d-${d}"]`)?.closest(".av-day").classList.toggle("has-off", !!form.querySelector(`[name="d-${d}"]:checked`)?.value));
  };
  form.addEventListener("change", count);
  form.querySelector("[data-reset]")?.addEventListener("click", () => { form.querySelectorAll('input[value=""]').forEach((i) => (i.checked = true)); count(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = days.map((d) => ({ unavailable_date: d, session: form.querySelector(`[name="d-${d}"]:checked`)?.value || "" })).filter((r) => r.session);
    const pref = form.querySelector('[name="pref"]:checked')?.value || "any";
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true; btn.textContent = "Saving…";
    try { await onSave(rows, pref); }
    finally { btn.disabled = false; btn.textContent = saveLabel; }
  });
  count();
}

// Save one person's answers (replaces what they said before)
export async function saveAnswers(roundId, lecturerId, rows, preference, source = "form") {
  await q(supabase.from("availability").delete().eq("round_id", roundId).eq("lecturer_id", lecturerId));
  if (rows.length) await q(supabase.from("availability").insert(rows.map((r) => ({ ...r, round_id: roundId, lecturer_id: lecturerId, source }))));
  await q(supabase.from("availability_responses").upsert(
    { round_id: roundId, lecturer_id: lecturerId, preference, submitted_at: new Date().toISOString(), source },
    { onConflict: "round_id,lecturer_id" }));
}

// =====================================================================
// LECTURER: "My availability" tab
// =====================================================================
export async function renderMyAvailability(panel, me) {
  if (!me) { panel.innerHTML = `<p class="muted">Your email isn't linked to a staff record, so you can't answer yet.</p>`; return; }
  panel.innerHTML = `<p class="loading">Loading…</p>`;
  const rounds = await q(supabase.from("availability_rounds").select("*").order("start_date", { ascending: false }));
  const open = rounds.filter((r) => r.is_open);
  const r = open[0] || rounds[0];
  if (!r) {
    panel.innerHTML = `<div class="empty table-wrap"><p><strong>No availability request right now.</strong></p>
      <p class="muted">Before each exam period the admin asks when you can't come for exam duties. It will appear here.</p></div>`;
    return;
  }
  const [mine, resp, days] = await Promise.all([
    q(supabase.from("availability").select("*").eq("round_id", r.id).eq("lecturer_id", me.id)),
    q(supabase.from("availability_responses").select("*").eq("round_id", r.id).eq("lecturer_id", me.id)),
    roundDays(r),
  ]);
  const answered = resp[0];
  panel.innerHTML = `
    <div class="av-head">
      <div>
        <h2>${esc(r.name)}</h2>
        <p class="muted">Exam days ${fmt(r.start_date, { day: "numeric", month: "long" })} – ${fmt(r.end_date, { day: "numeric", month: "long", year: "numeric" })}
          ${r.deadline ? ` · please answer by <b>${fmt(r.deadline, { weekday: "long", day: "numeric", month: "long" })}</b>` : ""}</p>
      </div>
      <span class="badge ${answered ? "active" : "hold"}">${answered ? `Sent ${new Date(answered.submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Not answered yet"}</span>
    </div>
    <div id="av-form"></div>`;
  availabilityForm({
    container: panel.querySelector("#av-form"), round: r, days, existing: mine,
    preference: answered?.preference || "any", readOnly: !r.is_open,
    saveLabel: answered ? "Update my availability" : "Send my availability",
    onSave: async (rows, pref) => {
      try {
        await saveAnswers(r.id, me.id, rows, pref);
        flash("Thank you — your availability was saved. You can change it until the request closes.");
        renderMyAvailability(panel, me);
      } catch (err) { flash(err.message || String(err), "error"); }
    },
  });
}

// =====================================================================
// ADMIN: the Availability page
// =====================================================================
export async function renderAvailabilityAdmin(root, roundId = null) {
  root.innerHTML = `<p class="loading">Loading…</p>`;
  const [rounds, staff, responses, answers] = await Promise.all([
    q(supabase.from("availability_rounds").select("*").order("start_date", { ascending: false })),
    q(supabase.from("lecturers").select("id,title,full_name,grade,faculty,email,on_hold").order("full_name")),
    q(supabase.from("availability_responses").select("*")),
    q(supabase.from("availability").select("*")),
  ]);
  const active = staff.filter((s) => !s.on_hold);
  const nm = (s) => `${s.title ? s.title + " " : ""}${s.full_name}`;
  const round = roundId ? rounds.find((r) => r.id === roundId) : null;

  // ----- list of requests -----
  if (!round) {
    root.innerHTML = `
      <h1 class="page-title">Availability</h1>
      <p class="page-sub">Before each exam period, ask staff which days or sessions they can't come. The timetable generator respects their answers automatically.</p>
      <div class="toolbar"><span class="spacer"></span><button class="btn" data-new><i class="ti ti-send"></i> New availability request</button></div>
      ${rounds.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Request</th><th>Exam days</th><th>Deadline</th><th>Answers</th><th>Status</th></tr></thead>
        <tbody>${rounds.map((r) => {
          const n = responses.filter((x) => x.round_id === r.id).length;
          return `<tr data-round="${r.id}" tabindex="0" title="Open">
            <td><b>${esc(r.name)}</b></td>
            <td>${fmt(r.start_date, { day: "numeric", month: "short" })} – ${fmt(r.end_date, { day: "numeric", month: "short", year: "numeric" })}</td>
            <td>${r.deadline ? fmt(r.deadline) : "—"}</td>
            <td><div class="progress"><span style="width:${Math.round((n / Math.max(1, active.length)) * 100)}%"></span></div> ${n} of ${active.length}</td>
            <td>${r.is_open ? '<span class="badge active">Open</span>' : '<span class="badge hold">Closed</span>'}</td></tr>`;
        }).join("")}</tbody></table></div>`
      : `<div class="empty table-wrap"><p><strong>No requests yet.</strong></p><p class="muted">Click “New availability request” before planning the next exam period.</p></div>`}`;
    root.querySelector("[data-new]").addEventListener("click", () => newRoundDialog(root));
    root.querySelectorAll("[data-round]").forEach((tr) => {
      tr.addEventListener("click", () => (location.hash = `availability/${tr.dataset.round}`));
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") tr.click(); });
    });
    return;
  }

  // ----- one request: who answered -----
  const resp = Object.fromEntries(responses.filter((x) => x.round_id === round.id).map((x) => [x.lecturer_id, x]));
  const offBy = {};
  answers.filter((a) => a.round_id === round.id).forEach((a) => (offBy[a.lecturer_id] ||= []).push(a));
  const done = active.filter((s) => resp[s.id]).length;
  let filter = "all";
  const link = new URL("lecturer.html", location.href).href;

  function draw() {
    const list = active.filter((s) => filter === "all" || (filter === "yes" ? resp[s.id] : !resp[s.id]));
    root.innerHTML = `
      <a class="back-link" href="#availability">← All availability requests</a>
      <div class="tt-head">
        <div>
          <h1 class="page-title">${esc(round.name)}</h1>
          <p class="page-sub">Exam days ${fmt(round.start_date, { day: "numeric", month: "long" })} – ${fmt(round.end_date, { day: "numeric", month: "long", year: "numeric" })}
            ${round.deadline ? ` · deadline ${fmt(round.deadline, { day: "numeric", month: "long" })}` : ""}
            · ${round.is_open ? '<span class="badge active">Open</span>' : '<span class="badge hold">Closed</span>'}</p>
        </div>
        <div class="tt-actions">
          <button class="btn light" data-copy><i class="ti ti-copy"></i> Copy message for staff</button>
          <button class="btn light" data-toggle>${round.is_open ? '<i class="ti ti-lock"></i> Close request' : '<i class="ti ti-lock-open"></i> Reopen'}</button>
        </div>
      </div>
      <div class="av-stats">
        <div class="stat static"><span class="num">${done}</span><span class="lab">answered</span></div>
        <div class="stat static"><span class="num">${active.length - done}</span><span class="lab">not answered yet</span></div>
        <div class="stat static"><span class="num">${Object.values(offBy).reduce((a, x) => a + x.length, 0)}</span><span class="lab">days marked “can't come”</span></div>
      </div>
      <div class="toolbar">
        <div class="seg small-seg" role="radiogroup" aria-label="Show">
          ${[["all", "Everyone"], ["no", "Not answered"], ["yes", "Answered"]].map(([v, l]) =>
            `<label class="yes"><input type="radio" name="f" value="${v}" ${filter === v ? "checked" : ""}><span>${l}</span></label>`).join("")}
        </div>
        <span class="spacer"></span>
        <button class="btn light" data-template><i class="ti ti-download"></i> CSV template</button>
        <label class="btn light"><i class="ti ti-file-import"></i> Import Google Form answers<input type="file" accept=".csv" hidden data-import></label>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Grade</th><th>Faculty</th><th>Answered</th><th>Can't come</th><th>Prefers</th></tr></thead>
        <tbody>${list.map((s) => `<tr data-staff="${s.id}" tabindex="0" title="Click to see or change their answer">
          <td><b>${esc(nm(s))}</b>${s.email ? "" : ' <span class="muted small">(no email)</span>'}</td>
          <td>${GRADE[s.grade] || s.grade}</td><td>${esc(s.faculty || "")}</td>
          <td>${resp[s.id] ? `${new Date(resp[s.id].submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}${resp[s.id].source === "import" ? ' <span class="muted small">(imported)</span>' : ""}` : '<span class="badge hold">No answer</span>'}</td>
          <td class="small">${esc(summarise(offBy[s.id] || [])) || (resp[s.id] ? '<span class="muted">Available every day</span>' : "")}</td>
          <td>${resp[s.id] ? ({ any: "—", AM: "Mornings", PM: "Afternoons" }[resp[s.id].preference]) : ""}</td></tr>`).join("")
          || `<tr><td colspan="6" class="muted center">Nobody here.</td></tr>`}</tbody></table></div>`;
  }
  draw();

  root.addEventListener("change", async (e) => {
    if (e.target.name === "f") { filter = e.target.value; draw(); }
    if (e.target.matches("[data-import]") && e.target.files[0]) {
      await importGoogleForm(e.target.files[0], round, active);
      e.target.value = "";
      renderAvailabilityAdmin(root, round.id);
    }
  });
  root.addEventListener("click", async (e) => {
    if (e.target.closest("[data-copy]")) {
      const msg = `Dear colleagues,\n\nPlease let us know which days or sessions you can't come for exam duties between ${fmt(round.start_date, { day: "numeric", month: "long" })} and ${fmt(round.end_date, { day: "numeric", month: "long", year: "numeric" })}` +
        `${round.deadline ? `, by ${fmt(round.deadline, { weekday: "long", day: "numeric", month: "long" })}` : ""}.\n\n` +
        `Log in here with your university email and open the “Availability” tab:\n${link}\n\nThank you.`;
      try { await navigator.clipboard.writeText(msg); flash("Message copied — paste it into an email or WhatsApp."); }
      catch { prompt("Copy this message:", msg); }
    }
    if (e.target.closest("[data-toggle]")) {
      await q(supabase.from("availability_rounds").update({ is_open: !round.is_open }).eq("id", round.id));
      flash(round.is_open ? "Closed — staff can no longer change their answers." : "Reopened — staff can answer again.");
      return renderAvailabilityAdmin(root, round.id);
    }
    if (e.target.closest("[data-template]")) {
      const csv = "staff,date,session,preference\nperera@example.lk,2026-11-18,Whole day,Mornings\nDr. AB Silva,2026-11-19,Morning,\n";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = "availability_template.csv"; a.click();
    }
    const row = e.target.closest("[data-staff]");
    if (row) {
      const s = active.find((x) => x.id === Number(row.dataset.staff));
      const dlg = document.createElement("dialog");
      dlg.className = "form-dialog detail-dialog";
      dlg.innerHTML = `<div class="detail"><h2>${esc(nm(s))}</h2><p class="muted">${GRADE[s.grade] || ""} · changes are saved as the admin's entry</p><div id="dlg-form"></div>
        <div class="dialog-actions"><button class="btn light" value="close">Close</button></div></div>`;
      document.body.appendChild(dlg); dlg.showModal();
      dlg.querySelector('[value="close"]').onclick = () => dlg.close();
      dlg.addEventListener("close", () => dlg.remove());
      availabilityForm({
        container: dlg.querySelector("#dlg-form"), round, days: await roundDays(round), existing: offBy[s.id] || [],
        preference: resp[s.id]?.preference || "any", saveLabel: "Save",
        onSave: async (rows, pref) => {
          try { await saveAnswers(round.id, s.id, rows, pref, "admin"); dlg.close(); flash("Saved."); renderAvailabilityAdmin(root, round.id); }
          catch (err) { flash(err.message || String(err), "error"); }
        },
      });
    }
  });
}

function newRoundDialog(root) {
  const dlg = document.createElement("dialog");
  dlg.className = "form-dialog";
  dlg.innerHTML = `<form method="dialog">
      <h2>New availability request</h2>
      <p class="muted">Staff will see this on their page and can answer until you close it.</p>
      <div class="grid">
        <div class="wide"><label for="r-name">Name *</label><input id="r-name" required placeholder="e.g. Availability – Nov/Dec 2026 exams"></div>
        <div><label for="r-start">First exam day *</label><input id="r-start" type="date" required></div>
        <div><label for="r-end">Last exam day *</label><input id="r-end" type="date" required></div>
        <div><label for="r-dead">Answer by</label><input id="r-dead" type="date"></div>
      </div>
      <p class="msg error form-msg"></p>
      <div class="dialog-actions"><button type="button" class="btn light" value="cancel">Cancel</button><button class="btn">Create</button></div>
    </form>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (id) => dlg.querySelector(id).value;
    const msg = dlg.querySelector(".form-msg");
    if (v("#r-start") > v("#r-end")) { msg.textContent = "The last day must be after the first day."; return msg.classList.add("show"); }
    try {
      const r = await q(supabase.from("availability_rounds").insert({ name: v("#r-name").trim(), start_date: v("#r-start"), end_date: v("#r-end"), deadline: v("#r-dead") || null }).select("id").single());
      dlg.close();
      flash("Request created. Use “Copy message for staff” to let them know.");
      location.hash = `availability/${r.id}`;
    } catch (err) { msg.textContent = err.message; msg.classList.add("show"); }
  });
}

// =====================================================================
// IMPORT Google Form answers (CSV exported from Google Sheets)
// Accepts one row per day:   staff, date, session, preference
// or one row per person with several dates in one cell ("18/11/2026, 19/11/2026").
// =====================================================================
function parseDate(raw, year) {
  const s = String(raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) {
    let [a, b, y] = [Number(m[1]), Number(m[2]), m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])];
    let d = a, mo = b;                       // Sri Lanka writes day/month …
    if (b > 12 && a <= 12) { d = b; mo = a; } // … unless the form exported month/day
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const t = Date.parse(/\d{4}/.test(s) ? s : `${s} ${year}`);
  return Number.isNaN(t) ? null : new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const sessionOf = (v) => {
  const s = String(v || "").toLowerCase();
  if (/morn|am\b|^am$|9/.test(s)) return "AM";
  if (/after|pm\b|^pm$|1 ?pm|13/.test(s)) return "PM";
  return "ALL";
};
const prefOf = (v) => { const s = String(v || "").toLowerCase(); return /morn|am/.test(s) ? "AM" : /after|pm/.test(s) ? "PM" : "any"; };
const plainName = (v) => String(v || "").toLowerCase().replace(/\b(snr|prof|dr|mr|mrs|ms|miss|lt|col)\b\.?/g, "").replace(/[^a-z0-9@.]+/g, " ").trim();

async function importGoogleForm(file, round, staff) {
  const { default: Papa } = await import("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/+esm");
  const parsed = await new Promise((res) => Papa.parse(file, { header: true, skipEmptyLines: "greedy", complete: res }));
  const cols = parsed.meta.fields || [];
  const pick = (re) => cols.find((c) => re.test(c.toLowerCase()));
  const cStaff = pick(/email/) || pick(/staff|name|lecturer/);
  const cDate = pick(/date|day/);
  const cSes = pick(/session|time|morning|afternoon/);
  const cPref = pick(/prefer/);
  if (!cStaff || !cDate) return flash("The file needs a column with the staff email or name, and a column with the dates.", "error");
  const year = round.start_date.slice(0, 4);
  const byEmail = Object.fromEntries(staff.filter((s) => s.email).map((s) => [s.email.toLowerCase(), s]));
  const byName = Object.fromEntries(staff.map((s) => [plainName(s.full_name), s]));
  const people = new Map(), unknown = new Set(), badDates = new Set(), outside = new Set();
  for (const r of parsed.data) {
    const who = String(r[cStaff] || "").trim();
    if (!who) continue;
    const s = byEmail[who.toLowerCase()] || byName[plainName(who)];
    if (!s) { unknown.add(who); continue; }
    const p = people.get(s.id) || people.set(s.id, { rows: new Map(), pref: "any" }).get(s.id);
    if (cPref && r[cPref]) p.pref = prefOf(r[cPref]);
    for (const part of String(r[cDate] || "").split(/[;,\n]+(?=\s*\d|\s*[A-Za-z]{3})/).map((x) => x.trim()).filter(Boolean)) {
      const d = parseDate(part, year);
      if (!d) { badDates.add(part); continue; }
      if (d < round.start_date || d > round.end_date) { outside.add(part); continue; }
      p.rows.set(d, sessionOf(cSes ? r[cSes] : ""));
    }
  }
  const total = [...people.values()].reduce((a, p) => a + p.rows.size, 0);
  const ok = confirm(`Ready to import answers from ${people.size} staff (${total} days they can't come).` +
    (unknown.size ? `\n\nNot found in Staff (skipped): ${[...unknown].slice(0, 8).join(", ")}${unknown.size > 8 ? "…" : ""}` : "") +
    (badDates.size ? `\n\nDates not understood (skipped): ${[...badDates].slice(0, 5).join(", ")}` : "") +
    (outside.size ? `\n\nOutside this request's dates (skipped): ${[...outside].slice(0, 5).join(", ")}` : "") +
    `\n\nThis replaces any earlier answers from these ${people.size} staff. Continue?`);
  if (!ok) return;
  try {
    for (const [id, p] of people) await saveAnswers(round.id, id, [...p.rows].map(([d, ses]) => ({ unavailable_date: d, session: ses })), p.pref, "import");
    flash(`Imported answers from ${people.size} staff.`);
  } catch (err) { flash(err.message || String(err), "error"); }
}
