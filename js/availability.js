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
// THE FORM — one row per exam day, two switches: Morning and Afternoon.
// Green = I can come (the default). Grey = I can't come.
//   minAvail: sessions this person must stay available in every exam week (seniority; null = no rule)
//   board:  who is already off, for the first-come-first-served check (lecturers only)
// =====================================================================
const GROUP_NAME = { SUP: "supervisors", INV: "invigilators", HA: "hall attendants" };
export function dutyGroup(s) {
  if (!s) return null;
  if (s.grade === "HA") return "HA";
  if (s.can_supervise) return "SUP";
  if (s.can_invigilate) return "INV";
  return null;
}
const isOff = (v, ses) => v === "ALL" || v === ses;

export function availabilityForm({ container, round, days, existing = [], preference = "any", readOnly = false,
  onSave, saveLabel = "Send my availability", minAvail = null, board = null, group = null }) {
  const start = Object.fromEntries(existing.map((r) => [r.unavailable_date, r.session]));
  // people already off in each session (not me), per cover group
  const offNames = {};          // "date|AM" -> [{ name, group }]
  (board?.off || []).filter((o) => !o.me).forEach((o) => {
    for (const ses of o.session === "ALL" ? ["AM", "PM"] : [o.session]) (offNames[`${o.date}|${ses}`] ||= []).push(o);
  });
  const g = group && board?.groups?.[group];
  const room = (d, ses) => (g ? g.total - g.need - (offNames[`${d}|${ses}`] || []).filter((o) => o.group === group).length : Infinity);

  const weeks = [];
  days.forEach((d) => {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    if (!weeks.length || wd === 1) weeks.push([]);
    weeks[weeks.length - 1].push(d);
  });
  const sw = (d, ses) => {
    const off = isOff(start[d], ses);
    const full = !off && room(d, ses) <= 0;
    const who = offNames[`${d}|${ses}`] || [];
    return `<div class="sw-wrap">
      <label class="sw ${off ? "" : "on"} ${full ? "full" : ""}">
        <input type="checkbox" data-d="${d}" data-s="${ses}" ${off ? "" : "checked"} ${readOnly || full ? "disabled" : ""}>
        <span class="sw-track"><span class="sw-knob"></span></span>
        <span class="sw-text"><b>${ses === "AM" ? "Morning" : "Afternoon"}</b><small>${full ? "Full — can't take off" : off ? "Can't come" : "Available"}</small></span>
      </label>
      ${who.length ? `<button type="button" class="link small who" data-who="${d}|${ses}">${who.length} off${full ? " · who?" : ""}</button>` : ""}
    </div>`;
  };
  container.innerHTML = `
    <form class="av-form">
      ${readOnly ? `<p class="msg show ok">This form is closed, so answers can't be changed any more.</p>` : ""}
      <div class="av-tools">
        <p class="small muted">Everything is <b class="green-text">available</b> unless you switch it off. Switch off only the sessions you <b>can't</b> come.
          ${board ? "Time off is first come, first served: a session closes when too few colleagues would be left to cover the halls." : ""}</p>
        ${readOnly ? "" : `<button type="button" class="link" data-reset>Mark all available</button>`}
      </div>
      <p class="av-limit"></p>
      ${weeks.map((w, wi) => `<fieldset class="av-week" data-week="${wi}"><legend>Week of ${fmt(w[0], { day: "numeric", month: "long" })}
        ${minAvail != null ? `<span class="wk-allow" data-allow="${wi}"></span>` : ""}</legend>
        ${w.map((d) => `<div class="av-day" data-day="${d}">
          <span class="av-date">${fmt(d)}</span>
          <div class="sw-pair">${sw(d, "AM")}${sw(d, "PM")}</div>
        </div>`).join("")}
      </fieldset>`).join("")}
      <fieldset class="av-pref"><legend>Do you prefer a session?</legend>
        <div class="seg" role="radiogroup">${PREFS.map(([v, l]) => `<label class="yes"><input type="radio" name="pref" value="${v}" ${preference === v ? "checked" : ""} ${readOnly ? "disabled" : ""}><span>${l}</span></label>`).join("")}</div>
        <p class="small muted">A preference is followed when possible; the sessions you can't come are always respected.</p>
      </fieldset>
      ${readOnly ? "" : `<button class="btn big" type="submit">${esc(saveLabel)}</button>`}
    </form>`;
  const form = container.querySelector("form");
  const offCount = () => form.querySelectorAll("input[data-d]:not(:checked)").length;
  // each week: sessions in it, how many must stay available, how many may be taken off
  const weekOf = Object.fromEntries(weeks.flatMap((w, wi) => w.map((d) => [d, wi])));
  const weekRule = (wi) => { const total = weeks[wi].length * 2, keep = Math.min(minAvail ?? 0, total); return { total, keep, maxOff: total - keep }; };
  const offInWeek = (wi) => [...form.querySelectorAll("input[data-d]:not(:checked)")].filter((i) => weekOf[i.dataset.d] === wi).length;
  const refresh = () => {
    const n = offCount();
    form.querySelectorAll("input[data-d]").forEach((i) => {
      const lab = i.closest(".sw");
      lab.classList.toggle("on", i.checked);
      if (!lab.classList.contains("full")) lab.querySelector("small").textContent = i.checked ? "Available" : "Can't come";
    });
    form.querySelectorAll(".av-day").forEach((row) => row.classList.toggle("has-off", !!row.querySelector("input[data-d]:not(:checked)")));
    if (minAvail != null) weeks.forEach((w, wi) => {
      const r = weekRule(wi), off = offInWeek(wi), el = form.querySelector(`[data-allow="${wi}"]`);
      if (el) { el.textContent = `· ${off} of ${r.maxOff} off allowed`; el.classList.toggle("warn-text", off >= r.maxOff); }
    });
    container.querySelector(".av-limit").innerHTML = (minAvail != null
      ? `Your grade must stay available for at least <b>${minAvail}</b> session${minAvail === 1 ? "" : "s"} in each exam week. `
      : "") + (n ? `${n} session${n > 1 ? "s" : ""} marked “can't come”.` : "You're available for every session.");
  };
  form.addEventListener("change", (e) => {
    const i = e.target;
    if (i.matches("input[data-d]") && !i.checked && minAvail != null) {
      const wi = weekOf[i.dataset.d], r = weekRule(wi);
      if (offInWeek(wi) > r.maxOff) {
        i.checked = true;
        flash(`In the week of ${fmt(weeks[wi][0], { day: "numeric", month: "short" })} you must stay available for at least ${r.keep} session${r.keep === 1 ? "" : "s"}, so at most ${r.maxOff} can be off.`, "error");
      }
    }
    refresh();
  });
  form.addEventListener("click", (e) => {
    const w = e.target.closest("[data-who]");
    if (!w) return;
    const [d, ses] = w.dataset.who.split("|");
    const list = offNames[w.dataset.who] || [];
    const mineG = list.filter((o) => o.group === group), others = list.filter((o) => o.group !== group);
    alert(`${fmt(d, { weekday: "long", day: "numeric", month: "long" })} — ${ses === "AM" ? "morning" : "afternoon"}\n\n` +
      (mineG.length ? `Off from your group (${GROUP_NAME[group] || "staff"}):\n• ${mineG.map((o) => o.name).join("\n• ")}\n\n` : "") +
      (others.length ? `Others off:\n• ${others.map((o) => o.name).join("\n• ")}\n\n` : "") +
      (room(d, ses) <= 0 && !isOff(start[d], ses) ? "This session is full. If you really can't come, ask one of the colleagues above to change their answer (before the deadline), or contact the exam office." : ""));
  });
  form.querySelector("[data-reset]")?.addEventListener("click", () => { form.querySelectorAll("input[data-d]").forEach((i) => (i.checked = true)); refresh(); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = days.map((d) => {
      const am = form.querySelector(`input[data-d="${d}"][data-s="AM"]`).checked, pm = form.querySelector(`input[data-d="${d}"][data-s="PM"]`).checked;
      return { unavailable_date: d, session: !am && !pm ? "ALL" : !am ? "AM" : !pm ? "PM" : "" };
    }).filter((r) => r.session);
    const pref = form.querySelector('[name="pref"]:checked')?.value || "any";
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true; btn.textContent = "Saving…";
    try { await onSave(rows, pref); }
    finally { btn.disabled = false; btn.textContent = saveLabel; }
  });
  refresh();
}

// Database messages → plain words
const tidy = (m) => String(m || "").replace(/^(FULL|LIMIT):\s*/, "");

// Save one person's answers. Only the days that changed are touched, so nobody loses
// a place they already have. Returns a list of problems (empty when all went well).
export async function saveAnswers(roundId, lecturerId, rows, preference, source = "form") {
  const before = await q(supabase.from("availability").select("*").eq("round_id", roundId).eq("lecturer_id", lecturerId));
  const want = Object.fromEntries(rows.map((r) => [r.unavailable_date, r.session]));
  const problems = [];
  // 1. days now available again (frees places first)
  const gone = before.filter((b) => !want[b.unavailable_date]).map((b) => b.id);
  if (gone.length) await q(supabase.from("availability").delete().in("id", gone));
  // 2. new or changed days, one at a time so one full session doesn't block the rest
  for (const [d, ses] of Object.entries(want)) {
    const old = before.find((b) => b.unavailable_date === d);
    if (old?.session === ses) continue;
    const { error } = old
      ? await supabase.from("availability").update({ session: ses, source }).eq("id", old.id)
      : await supabase.from("availability").insert({ round_id: roundId, lecturer_id: lecturerId, unavailable_date: d, session: ses, source });
    if (error) problems.push(`${fmt(d)}: ${tidy(error.message)}`);
  }
  await q(supabase.from("availability_responses").upsert(
    { round_id: roundId, lecturer_id: lecturerId, preference, submitted_at: new Date().toISOString(), source },
    { onConflict: "round_id,lecturer_id" }));
  return problems;
}

// Is the deadline still ahead? (Sri Lanka time)
export function roundEditable(r) {
  if (!r?.is_open) return false;
  if (!r.deadline) return true;
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  return today <= r.deadline;
}
const daysLeft = (deadline) => {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  return Math.round((new Date(deadline + "T00:00:00Z") - new Date(today + "T00:00:00Z")) / 86400000);
};

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
      <p class="muted">Before each exam period the exam office asks when you can't come for exam duties. You'll get an email, and the form will appear here.</p></div>`;
    return;
  }
  const [mine, resp, days, boardRes] = await Promise.all([
    q(supabase.from("availability").select("*").eq("round_id", r.id).eq("lecturer_id", me.id)),
    q(supabase.from("availability_responses").select("*").eq("round_id", r.id).eq("lecturer_id", me.id)),
    roundDays(r),
    supabase.rpc("availability_board", { p_round: r.id }),
  ]);
  const answered = resp[0];
  const editable = roundEditable(r);
  const minAvail = r.min_available?.[me.grade] ?? null;
  const left = r.deadline ? daysLeft(r.deadline) : null;
  panel.innerHTML = `
    <div class="av-head">
      <div>
        <h2>${esc(r.name)}</h2>
        <p class="muted">Exam days ${fmt(r.start_date, { day: "numeric", month: "long" })} – ${fmt(r.end_date, { day: "numeric", month: "long", year: "numeric" })}</p>
        ${r.deadline ? `<p class="deadline ${editable ? (left <= 2 ? "soon" : "") : "past"}"><i class="ti ti-clock"></i>
          ${editable ? `Answer by <b>${fmt(r.deadline, { weekday: "long", day: "numeric", month: "long" })}</b> · ${left === 0 ? "today is the last day" : `${left} day${left === 1 ? "" : "s"} left`}. You can change your answer until then.`
            : `Closed on ${fmt(r.deadline, { weekday: "long", day: "numeric", month: "long" })}.`}</p>` : ""}
      </div>
      <span class="badge ${answered ? "active" : "hold"}">${answered ? `Sent ${new Date(answered.submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Not answered yet"}</span>
    </div>
    <div id="av-msg"></div>
    <div id="av-form"></div>`;
  availabilityForm({
    container: panel.querySelector("#av-form"), round: r, days, existing: mine,
    preference: answered?.preference || "any", readOnly: !editable,
    saveLabel: answered ? "Update my availability" : "Send my availability",
    minAvail, board: boardRes.data, group: dutyGroup(me),
    onSave: async (rows, pref) => {
      try {
        const problems = await saveAnswers(r.id, me.id, rows, pref);
        document.dispatchEvent(new CustomEvent("availability-saved"));
        await renderMyAvailability(panel, me);
        if (problems.length) {
          panel.querySelector("#av-msg").innerHTML = `<div class="msg show error"><b>Some sessions could not be taken off:</b><br>${problems.map(esc).join("<br>")}</div>`;
          flash("Saved, but some sessions are full — see the message at the top.", "error");
        } else flash("Thank you — your availability was saved. You can change it until the deadline.");
      } catch (err) { flash(tidy(err.message || String(err)), "error"); }
    },
  });
}

// ----- emails (Supabase function "send-mail") -----
async function sendMail(round, kind) {
  const site = new URL(".", location.href).href;
  const { data, error } = await supabase.functions.invoke("send-mail", { body: { round_id: round.id, kind, site } });
  if (error) {
    let m = error.message;
    try { m = (await error.context?.json())?.error || m; } catch {}
    throw new Error(m);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// =====================================================================
// ADMIN: the Availability page
// =====================================================================
export async function renderAvailabilityAdmin(root, roundId = null) {
  // one set of page listeners at a time (the page area is shared, so old ones must go)
  root._pageAbort?.abort();
  root._pageAbort = new AbortController();
  const once = { signal: root._pageAbort.signal };
  const on = (type, fn) => root.addEventListener(type, fn, once);
  root.innerHTML = `<p class="loading">Loading…</p>`;
  const [rounds, staff, responses, answers] = await Promise.all([
    q(supabase.from("availability_rounds").select("*").order("start_date", { ascending: false })),
    q(supabase.from("lecturers").select("id,title,full_name,grade,faculty,email,on_hold,can_supervise,can_invigilate").order("full_name")),
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
        <thead><tr><th>Request</th><th>Exam days</th><th>Deadline</th><th>Answers</th><th>Status</th><th></th></tr></thead>
        <tbody>${rounds.map((r) => {
          const n = responses.filter((x) => x.round_id === r.id).length;
          return `<tr data-round="${r.id}" tabindex="0" title="Open">
            <td><b>${esc(r.name)}</b></td>
            <td>${fmt(r.start_date, { day: "numeric", month: "short" })} – ${fmt(r.end_date, { day: "numeric", month: "short", year: "numeric" })}</td>
            <td>${r.deadline ? fmt(r.deadline) : "—"}</td>
            <td><div class="progress"><span style="width:${Math.round((n / Math.max(1, active.length)) * 100)}%"></span></div> ${n} of ${active.length}</td>
            <td>${!r.is_open ? '<span class="badge hold">Closed</span>' : roundEditable(r) ? '<span class="badge active">Open</span>' : '<span class="badge hold">Deadline passed</span>'}</td>
            <td class="actions"><button class="link danger" data-del-round="${r.id}" title="Delete this request and its answers">Delete</button></td></tr>`;
        }).join("")}</tbody></table></div>`
      : `<div class="empty table-wrap"><p><strong>No requests yet.</strong></p><p class="muted">Click “New availability request” before planning the next exam period.</p></div>`}`;
    root.querySelector("[data-new]").addEventListener("click", () => roundDialog(root));
    root.querySelectorAll("[data-del-round]").forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const r = rounds.find((x) => x.id === Number(b.dataset.delRound));
      if (await deleteRound(r, responses.filter((x) => x.round_id === r.id).length)) renderAvailabilityAdmin(root);
    }));
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
  const link = new URL("lecturer.html#availability", location.href).href;
  const noAnswer = active.filter((s) => !resp[s.id] && s.email).length;
  // sessions that are full (first come, first served) — per cover group
  const H = round.halls_per_session || 0;
  const need = { SUP: H, INV: Math.ceil(H * 1.5), HA: H };
  const total = {};
  active.forEach((s) => { const g = dutyGroup(s); if (g) total[g] = (total[g] || 0) + 1; });
  const offCount = {};
  answers.filter((a) => a.round_id === round.id).forEach((a) => {
    const s = active.find((x) => x.id === a.lecturer_id); const g = dutyGroup(s);
    if (!g) return;
    for (const ses of a.session === "ALL" ? ["AM", "PM"] : [a.session]) { const k = `${a.unavailable_date}|${ses}|${g}`; offCount[k] = (offCount[k] || 0) + 1; }
  });
  const fullList = Object.entries(offCount).filter(([k, n]) => { const g = k.split("|")[2]; return total[g] - n <= need[g]; })
    .map(([k, n]) => { const [d, ses, g] = k.split("|"); return `${fmt(d)} ${ses === "AM" ? "morning" : "afternoon"} — ${n} ${GROUP_NAME[g]} off`; }).sort();

  function draw() {
    const list = active.filter((s) => filter === "all" || (filter === "yes" ? resp[s.id] : !resp[s.id]));
    root.innerHTML = `
      <a class="back-link" href="#availability">← All availability requests</a>
      <div class="tt-head">
        <div>
          <h1 class="page-title">${esc(round.name)}</h1>
          <p class="page-sub">Exam days ${fmt(round.start_date, { day: "numeric", month: "long" })} – ${fmt(round.end_date, { day: "numeric", month: "long", year: "numeric" })}
            ${round.deadline ? ` · deadline ${fmt(round.deadline, { day: "numeric", month: "long" })}` : ""}
            · ${!round.is_open ? '<span class="badge hold">Closed</span>' : roundEditable(round) ? '<span class="badge active">Open</span>' : '<span class="badge hold">Deadline passed</span>'}</p>
          <p class="small muted">${round.emailed_at ? `Emailed to staff ${new Date(round.emailed_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Not emailed yet"}
            ${round.reminded_at ? ` · reminder sent ${new Date(round.reminded_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
            · ${H ? `${H} halls per session` : "no session cap"} · must stay available per week: ${Object.entries(round.min_available || {}).map(([g, n]) => `${GRADE[g] || g} ${n}`).join(", ")}</p>
        </div>
        <div class="tt-actions">
          ${round.emailed_at ? `<button class="btn" data-mail="reminder" ${noAnswer ? "" : "disabled"}><i class="ti ti-bell"></i> Remind ${noAnswer} not answered</button>`
            : `<button class="btn" data-mail="invite"><i class="ti ti-mail"></i> Email all staff</button>`}
          <button class="btn light" data-mail="test" title="Send the email only to yourself, to check the set-up"><i class="ti ti-mail-check"></i> Test email</button>
          <button class="btn light" data-settings><i class="ti ti-settings"></i> Settings</button>
          <button class="btn light danger" data-del-this title="Delete this request and all its answers"><i class="ti ti-trash"></i> Delete</button>
          <button class="btn light" data-toggle>${round.is_open ? '<i class="ti ti-lock"></i> Close' : '<i class="ti ti-lock-open"></i> Reopen'}</button>
        </div>
      </div>
      <div class="av-stats">
        <div class="stat static"><span class="num">${done}</span><span class="lab">answered</span></div>
        <div class="stat static"><span class="num">${active.length - done}</span><span class="lab">not answered yet</span></div>
        <div class="stat static"><span class="num">${Object.values(offBy).reduce((a, x) => a + x.length, 0)}</span><span class="lab">days marked “can't come”</span></div>
        <div class="stat static"><span class="num">${fullList.length}</span><span class="lab">sessions full</span></div>
      </div>
      ${fullList.length ? `<details class="picker"><summary>Full sessions (nobody else in that group can take them off)</summary><ul class="plain small">${fullList.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
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

  on("change", async (e) => {
    if (e.target.name === "f") { filter = e.target.value; draw(); }
    if (e.target.matches("[data-import]") && e.target.files[0]) {
      await importGoogleForm(e.target.files[0], round, active);
      e.target.value = "";
      renderAvailabilityAdmin(root, round.id);
    }
  });
  on("click", async (e) => {
    const mail = e.target.closest("[data-mail]");
    if (mail) {
      const kind = mail.dataset.mail;
      if (kind !== "test" && !confirm(kind === "reminder" ? `Send a reminder email to the ${noAnswer} staff who haven't answered?` : `Email all ${active.filter((s) => s.email).length} staff with an email address about this request?`)) return;
      mail.disabled = true; mail.innerHTML = '<i class="ti ti-loader-2 spin"></i> Sending…';
      try { const r = await sendMail(round, kind); flash(kind === "test" ? "Test email sent to you — check your inbox." : `Email sent to ${r.sent} staff.`); }
      catch (err) { flash(`Email not sent: ${err.message}`, "error"); }
      return renderAvailabilityAdmin(root, round.id);
    }
    if (e.target.closest("[data-settings]")) return roundDialog(root, round);
    if (e.target.closest("[data-copy]")) {
      const msg = `Dear colleagues,\n\nPlease let us know which days or sessions you can't come for exam duties between ${fmt(round.start_date, { day: "numeric", month: "long" })} and ${fmt(round.end_date, { day: "numeric", month: "long", year: "numeric" })}` +
        `${round.deadline ? `, by ${fmt(round.deadline, { weekday: "long", day: "numeric", month: "long" })}` : ""}.\n\n` +
        `Log in here with your university email and open the “Availability” tab:\n${link}\n\nThank you.`;
      try { await navigator.clipboard.writeText(msg); flash("Message copied — paste it into an email or WhatsApp."); }
      catch { prompt("Copy this message:", msg); }
    }
    if (e.target.closest("[data-del-this]")) {
      if (await deleteRound(round, Object.keys(resp).length)) location.hash = "availability";
      return;
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
          try { const p = await saveAnswers(round.id, s.id, rows, pref, "admin"); dlg.close(); flash(p.length ? p.join(" · ") : "Saved.", p.length ? "error" : "ok"); renderAvailabilityAdmin(root, round.id); }
          catch (err) { flash(err.message || String(err), "error"); }
        },
      });
    }
  });
}

// Delete a request with all its answers (asks first)
async function deleteRound(r, answered) {
  const warn = answered
    ? `Delete “${r.name}”?\n\n${answered} staff answered it — their answers are deleted too and the timetable generator will no longer see them. This cannot be undone.`
    : `Delete “${r.name}”? This cannot be undone.`;
  if (!confirm(warn)) return false;
  if (answered && prompt("Type DELETE to confirm.")?.trim().toUpperCase() !== "DELETE") return false;
  try { await q(supabase.from("availability_rounds").delete().eq("id", r.id)); }
  catch (err) { flash(err.message || String(err), "error"); return false; }
  flash("Availability request deleted.");
  return true;
}

// Create a request, or change one's settings
async function roundDialog(root, round = null) {
  const rooms = await q(supabase.from("rooms").select("id,on_hold"));
  // defaults follow the weekly duty limits (Settings), e.g. Prof 2, SL Gr I 2, SL Gr II 5, Lecturer 7, others 8
  const { data: lim } = await supabase.from("settings").select("value").eq("key", "weekly_limits").maybeSingle();
  const defaults = { PROF: 2, SL1: 2, SL2: 5, LECT: 7, INSTR: 8, MIL: 8, HA: 8, ...(lim?.value || {}) };
  const max = { ...defaults, ...(round?.min_available || {}) };
  const halls = round?.halls_per_session ?? rooms.filter((r) => !r.on_hold).length;
  const dlg = document.createElement("dialog");
  dlg.className = "form-dialog";
  dlg.innerHTML = `<form method="dialog">
      <h2>${round ? "Request settings" : "New availability request"}</h2>
      <p class="muted">Staff answer on their page until the deadline. After the deadline nobody can change their answer (you still can).</p>
      <div class="grid">
        <div class="wide"><label for="r-name">Name *</label><input id="r-name" required placeholder="e.g. Availability – Nov/Dec 2026 exams" value="${esc(round?.name || "")}"></div>
        <div><label for="r-start">First exam day *</label><input id="r-start" type="date" required value="${round?.start_date || ""}"></div>
        <div><label for="r-end">Last exam day *</label><input id="r-end" type="date" required value="${round?.end_date || ""}"></div>
        <div><label for="r-dead">Deadline (last day to answer) *</label><input id="r-dead" type="date" required value="${round?.deadline || ""}"></div>
        <div><label for="r-halls">Halls used in a busy session</label><input id="r-halls" type="number" min="0" value="${halls}"></div>
      </div>
      <p class="gen-sub">Each grade must stay available for at least this many sessions in every exam week (out of 10)</p>
      <div class="limits">${Object.entries(GRADE).map(([k, l]) => `<label>${l}<input type="number" min="0" max="10" data-max="${k}" value="${max[k] ?? 8}"></label>`).join("")}</div>
      <p class="small muted">E.g. Professor 2: a professor may mark most of a week “can't come”, as long as 2 sessions stay open. A short week (fewer exam days) asks for no more than it has.</p>
      <p class="small muted">First come, first served: a session closes for a group when too few would be left —
        supervisors need 1 per hall, invigilators 1.5 per hall, hall attendants 1 per hall. Set halls to 0 to switch this off.</p>
      ${round ? "" : `<label class="check"><input type="checkbox" id="r-mail" checked> Email all staff now (from the exam office Gmail)</label>`}
      <p class="msg error form-msg"></p>
      <div class="dialog-actions"><button type="button" class="btn light" value="cancel">Cancel</button><button class="btn">${round ? "Save" : "Create"}</button></div>
    </form>`;
  document.body.appendChild(dlg); dlg.showModal();
  dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
  dlg.addEventListener("close", () => dlg.remove());
  dlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (id) => dlg.querySelector(id).value;
    const msg = dlg.querySelector(".form-msg");
    const fail = (t) => { msg.textContent = t; msg.classList.add("show"); };
    if (v("#r-start") > v("#r-end")) return fail("The last exam day must be after the first.");
    if (v("#r-dead") > v("#r-start")) return fail("The deadline should be before the first exam day.");
    const row = {
      name: v("#r-name").trim(), start_date: v("#r-start"), end_date: v("#r-end"), deadline: v("#r-dead"),
      halls_per_session: Number(v("#r-halls")) || 0,
      min_available: Object.fromEntries([...dlg.querySelectorAll("[data-max]")].map((i) => [i.dataset.max, Number(i.value) || 0])),
    };
    try {
      if (round) {
        await q(supabase.from("availability_rounds").update(row).eq("id", round.id));
        dlg.close(); flash("Saved."); return renderAvailabilityAdmin(root, round.id);
      }
      const r = await q(supabase.from("availability_rounds").insert(row).select("*").single());
      const mail = dlg.querySelector("#r-mail").checked;
      dlg.close();
      if (mail) {
        try { const res = await sendMail(r, "invite"); flash(`Request created and emailed to ${res.sent} staff.`); }
        catch (err) { flash(`Request created, but the email was not sent: ${err.message}`, "error"); }
      } else flash("Request created. Use “Email all staff” when you're ready.");
      location.hash = `availability/${r.id}`;
    } catch (err) { fail(err.message); }
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
