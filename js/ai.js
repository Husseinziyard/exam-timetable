// =====================================================================
// AI ASSISTANT (the right-hand panel on the timetable page)
// 1. The admin types a request in plain words.
// 2. The timetable is summarised as text and sent, with the request, to the
//    "ai-assistant" Supabase function (which holds the Gemini key).
// 3. Gemini suggests changes. Each one is CHECKED here against the rules
//    and shown with an Apply button — nothing changes until the admin clicks.
// =====================================================================
import { supabase } from "./config.js";
import { candidates, slotStatus } from "./edit.js";
import { toast } from "./crud.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" });
const ROLE = { SUPERVISOR: "supervisor", INVIGILATOR: "invigilator", ATTENDANT: "hall attendant" };
const SHORT = { SUPERVISOR: "SUP", INVIGILATOR: "INV", ATTENDANT: "HA" };
const num = (v) => Number(String(v ?? "").replace(/\D/g, "")) || null;

// the conversation survives page refreshes inside this browser tab
const chats = new Map();      // periodId -> { messages: [{ role, text, actions? }], queue: [] }

// ---------- the timetable as compact text for the AI ----------
function contextText(T) {
  const name = (id) => { const s = T.staffById[id]; return s ? `${s.title ? s.title + " " : ""}${s.full_name}` : "?"; };
  const load = {};
  T.halls.forEach((h) => h.duties.forEach((d) => { load[d.staffId] = (load[d.staffId] || 0) + 1; }));
  const papers = T.exams.map((e) => {
    const m = T.moduleById[e.moduleId] || {};
    const hs = T.halls.filter((h) => h.exams.some((x) => x.examId === e.id)).map((h) => `H${h.id}`);
    return `E${e.id} | ${m.code} ${m.name} | ${(T.batchesOf[e.moduleId] || []).map((b) => T.batchLite[b]?.label).join(", ")} | ${e.date} ${e.session}${e.locked ? " LOCKED" : ""} | ${hs.join(" ")}`;
  });
  const halls = T.halls.map((h) => {
    const n = h.exams.reduce((a, x) => a + x.seats, 0);
    return `H${h.id} | ${h.date} ${h.session} | ${h.roomName} | ${n}/${h.cap} | ` +
      h.duties.map((d) => `D${d.id} ${SHORT[d.role]} S${d.staffId}`).join("; ");
  });
  const staff = Object.values(T.staffById).filter((s) => !s.on_hold).map((s) => {
    const leave = (T.staffLite.find((x) => x.id === s.id)?.leave || []).map(([a, b]) => `${a}..${b}`).join(",");
    return `S${s.id} | ${name(s.id)} | ${s.grade} | sup:${s.can_supervise ? "yes" : "no"} inv:${s.can_invigilate ? "yes" : "no"} | duties:${load[s.id] || 0}${leave ? ` | leave:${leave}` : ""}`;
  });
  return [
    `PERIOD: ${T.period.name} (${T.period.start_date} to ${T.period.end_date}), status ${T.period.status}. Second invigilator when more than ${T.threshold} students.`,
    `FREE SLOTS (exam days): ${T.days.join(", ")} — each has AM and PM.`,
    "PAPERS:", ...papers, "HALLS:", ...halls, "STAFF:", ...staff,
  ].join("\n");
}

// ---------- check one suggestion against the current timetable ----------
function check(T, a) {
  const name = (id) => { const s = T.staffById[id]; return s ? `${s.title ? s.title + " " : ""}${s.full_name}` : null; };
  const code = (e) => T.moduleById[e.moduleId]?.code || "?";
  const findDuty = (id) => { for (const h of T.halls) { const d = h.duties.find((x) => x.id === id); if (d) return { h, d }; } return null; };
  const out = { type: a.type, reason: a.reason || "" };
  try {
    if (a.type === "move" || a.type === "lock") {
      const e = T.exams.find((x) => x.id === num(a.exam_id));
      if (!e) throw new Error("that paper isn't in this timetable");
      out.examId = e.id;
      if (a.type === "lock") { out.text = `Lock ${code(e)} on ${fmt(e.date)} ${e.session}`; if (e.locked) throw new Error("already locked"); return out; }
      const session = String(a.session || "").toUpperCase();
      const st = slotStatus(T, e, a.date, session);
      out.date = a.date; out.session = session;
      out.text = `Move ${code(e)} from ${fmt(e.date)} ${e.session} to ${fmt(a.date)} ${session}`;
      if (st.cls === "cur") throw new Error("it is already there");
      if (st.cls === "bad") throw new Error(st.note);
      if (st.cls === "warn") out.warn = st.note;
      return out;
    }
    if (a.type === "replace" || a.type === "remove") {
      const f = findDuty(num(a.duty_id));
      if (!f) throw new Error("that duty doesn't exist any more");
      out.dutyId = f.d.id;
      const where = `${f.h.roomName}, ${fmt(f.h.date)} ${f.h.session}`;
      if (a.type === "remove") { out.text = `Remove ${name(f.d.staffId)} (${ROLE[f.d.role]}) from ${where}`; return out; }
      const sid = num(a.staff_id);
      out.staffId = sid;
      out.text = `${where}: ${ROLE[f.d.role]} ${name(f.d.staffId)} → ${name(sid) || "?"}`;
      if (!name(sid)) throw new Error("unknown person");
      if (sid === f.d.staffId) throw new Error("same person");
      if (!candidates(T, f.h.date, f.h.session, f.d.role).some((c) => c.s.id === sid))
        throw new Error(`${name(sid)} can't take this duty (busy that session, on leave, on hold, or not allowed this role)`);
      return out;
    }
    if (a.type === "add") {
      const h = T.halls.find((x) => x.id === num(a.hall_id));
      if (!h) throw new Error("that hall session doesn't exist");
      const role = String(a.role || "").toUpperCase();
      if (!ROLE[role]) throw new Error("unknown role");
      const sid = num(a.staff_id);
      Object.assign(out, { hallId: h.id, role, staffId: sid });
      out.text = `Add ${name(sid) || "?"} as ${ROLE[role]} in ${h.roomName}, ${fmt(h.date)} ${h.session}`;
      if (!candidates(T, h.date, h.session, role).some((c) => c.s.id === sid))
        throw new Error(`${name(sid) || "that person"} can't take this duty (busy, on leave, on hold, or not allowed this role)`);
      return out;
    }
    throw new Error("unknown kind of change");
  } catch (err) {
    out.text ||= `${a.type} ${a.exam_id || a.duty_id || a.hall_id || ""}`;
    out.blocked = err.message;
    return out;
  }
}

// =====================================================================
export function mountAI({ panel, T, periodId, editor, refresh }) {
  const chat = chats.get(periodId) || chats.set(periodId, { messages: [], queue: [] }).get(periodId);
  let busy = false;
  const ro = T.period.status === "published";     // the live version is changed through a draft copy

  function draw() {
    const msgs = chat.messages.map((m, mi) => {
      if (m.role === "user") return `<div class="ai-msg user">${esc(m.text)}</div>`;
      if (m.role === "error") return `<div class="ai-msg error">${esc(m.text)}</div>`;
      const checked = (m.actions || []).map((a) => check(T, a));
      const open = checked.filter((c, i) => !m.done?.[i] && !c.blocked);
      return `<div class="ai-msg bot">
        <p>${esc(m.text).replace(/\n/g, "<br>")}</p>
        ${checked.length ? `<ol class="ai-actions">${checked.map((c, i) => `
          <li class="${m.done?.[i] ? "done" : c.blocked ? "blocked" : "ok"}">
            <span class="what">${esc(m.done?.[i]?.text || c.text)}</span>
            ${c.reason ? `<span class="why">${esc(c.reason)}</span>` : ""}
            ${m.done?.[i] ? `<span class="tag-ok"><i class="ti ti-check"></i> Applied</span>`
              : c.blocked ? `<span class="tag-bad"><i class="ti ti-ban"></i> Can't apply: ${esc(c.blocked)}</span>`
              : ro ? `<span class="tag-warn">Click Edit first to apply changes</span>`
              : `${c.warn ? `<span class="tag-warn">Note: ${esc(c.warn)}</span>` : ""}<button class="btn small" data-apply="${mi}:${i}">Apply</button>`}
          </li>`).join("")}</ol>
          ${open.length > 1 && !ro ? `<button class="btn light small full" data-apply-all="${mi}">Apply all ${open.length} that pass the checks</button>` : ""}` : ""}
        ${m.model ? `<p class="ai-model">${esc(m.model)}</p>` : ""}
      </div>`;
    }).join("");
    panel.innerHTML = `
      ${ro ? '<p class="ai-ro"><i class="ti ti-info-circle"></i> This is the published version. You can ask questions here; to apply changes, click <b>Edit</b> to work on a copy.</p>' : ""}
      ${chat.messages.length ? '<div class="ai-top"><button class="link" data-clear><i class="ti ti-plus"></i> New chat</button></div>' : ""}
      ${chat.messages.length ? "" : `<p class="small">Ask in plain words. The assistant suggests changes; each one is checked against the faculty's rules, and nothing changes until you click <b>Apply</b>.</p>
        <div class="ai-examples">${[
          "Dr. Perera is on leave on 18 November. Replace all her duties.",
          "Which lecturers have the most duties? Balance it a little.",
          "Give ADSC at least one free day before every exam.",
          "Is any hall short of staff?",
        ].map((x) => `<button class="ai-ex">${esc(x)}</button>`).join("")}</div>`}
      <div class="ai-log">${msgs}${busy ? '<div class="ai-msg bot thinking"><i class="ti ti-loader-2 spin"></i> Thinking… (this can take up to a minute)</div>' : ""}</div>
      <form class="ai-form">
        <textarea class="ai-input" rows="3" placeholder="e.g. Move BBA 4304 to a Thursday" aria-label="Ask the assistant" ${busy ? "disabled" : ""}></textarea>
        <button class="btn full" ${busy ? "disabled" : ""}>Ask</button>
      </form>`;
    const log = panel.querySelector(".ai-log");
    log.scrollTop = log.scrollHeight;
  }

  async function ask(question) {
    chat.messages.push({ role: "user", text: question });
    busy = true; draw();
    try {
      const history = chat.messages.slice(0, -1).filter((m) => m.role !== "error").map((m) => ({ role: m.role === "user" ? "user" : "assistant", text: m.text }));
      const { data, error } = await supabase.functions.invoke("ai-assistant", { body: { question, context: contextText(T), history } });
      if (error) {
        let msg = error.message || String(error);
        try { const body = await error.context?.json?.(); if (body?.error) msg = body.error; } catch {}
        if (/Failed to send|not found|404/i.test(msg)) msg = "The assistant isn't set up yet (the “ai-assistant” function wasn't found in Supabase).";
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      chat.messages.push({ role: "assistant", text: data.reply || "(no answer)", actions: data.actions || [], done: {}, model: data.model });
    } catch (err) {
      chat.messages.push({ role: "error", text: err.message || String(err) });
    }
    busy = false; draw();
  }

  // apply one change; the page reloads so the next check sees the new timetable
  async function apply(mi, i) {
    const m = chat.messages[mi];
    const c = check(T, m.actions[i]);
    if (c.blocked) { toast(`Can't apply: ${c.blocked}`, "error"); return draw(); }
    panel.classList.add("busy");
    try {
      await editor.applyAction(c);
      m.done[i] = { text: c.text };      // remember the wording from before the change
      return true;
    } catch (err) {
      toast(err.message || String(err), "error");
      return false;
    } finally { panel.classList.remove("busy"); }
  }

  panel.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = panel.querySelector(".ai-input");
    const v = t.value.trim();
    if (!v) { t.focus(); return toast("Type a question first.", "error"); }
    ask(v);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && e.target.matches(".ai-input")) { e.preventDefault(); panel.querySelector(".ai-form").requestSubmit(); }
  });
  panel.addEventListener("click", async (e) => {
    const ex = e.target.closest(".ai-ex");
    if (ex) { panel.querySelector(".ai-input").value = ex.textContent; return panel.querySelector(".ai-input").focus(); }
    if (e.target.closest("[data-clear]")) { chat.messages = []; chat.queue = []; return draw(); }
    const one = e.target.closest("[data-apply]");
    if (one) {
      const [mi, i] = one.dataset.apply.split(":").map(Number);
      if (await apply(mi, i)) { toast("Applied and locked."); refresh(); }
      return;
    }
    const all = e.target.closest("[data-apply-all]");
    if (all) {
      const mi = Number(all.dataset.applyAll);
      chat.queue = chat.messages[mi].actions.map((_, i) => [mi, i]).filter(([, i]) => !chat.messages[mi].done[i]);
      return runQueue();
    }
  });

  // "Apply all": one change at a time, re-checking each against the updated timetable
  async function runQueue() {
    while (chat.queue.length) {
      const [mi, i] = chat.queue.shift();
      const c = check(T, chat.messages[mi].actions[i]);
      if (c.blocked) continue;
      if (await apply(mi, i)) { toast("Applied and locked."); return refresh(); }   // the new page carries on with the queue
    }
  }

  draw();
  if (chat.queue.length) runQueue();
}
