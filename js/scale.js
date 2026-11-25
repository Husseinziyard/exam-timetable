// =====================================================================
// LOAD SCALE (right-hand sidebar on the timetable page)
// For one week at a time: how many of the 10 sessions (5 days × morning /
// afternoon) each person works, against the limit for their grade.
// =====================================================================
import { weekOf, unavailable } from "./engine.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s, o = { day: "numeric", month: "short" }) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const add = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const GROUPS = [
  ["PROF", "Professors"], ["SL1", "Senior Lecturers Gr. I"], ["SL2", "Senior Lecturers Gr. II"],
  ["LECT", "Lecturers"], ["INSTR", "Instructors"], ["MIL", "Military invigilators"], ["HA", "Hall attendants"],
];

export function mountScale({ panel, T, ui, onWeek }) {
  const weeks = [...new Set(T.days.map(weekOf))].sort();
  if (!weeks.length) { panel.innerHTML = `<p class="muted small">No exam days in this period.</p>`; return; }
  let wi = Math.max(0, weeks.indexOf(ui.week));
  let showAll = false;

  function draw() {
    const wk = weeks[wi];
    const days = [0, 1, 2, 3, 4].map((i) => add(wk, i));
    const slots = days.flatMap((d) => ["AM", "PM"].map((s) => ({ d, s })));      // the 10 sessions of the week
    // who works which session this week
    const work = {};
    T.halls.filter((h) => weekOf(h.date) === wk).forEach((h) => h.duties.forEach((d) => {
      (work[d.staffId] ||= new Set()).add(`${h.date}|${h.session}`);
    }));
    const people = T.staffLite.filter((s) => !s.onHold || work[s.id]);
    const over = people.filter((s) => s.cap != null && (work[s.id]?.size || 0) > s.cap);

    const bar = (s) => {
      const mine = work[s.id] || new Set();
      return `<div class="sc-bar" role="img" aria-label="${mine.size} of 10 sessions, limit ${s.cap}">${slots.map(({ d, s: ses }, i) => {
        const on = mine.has(`${d}|${ses}`);
        const off = unavailable(s, d, ses);
        const cls = on ? (mine.size > s.cap ? "on over" : "on") : off ? "off" : i >= s.cap ? "beyond" : "";
        return `<span class="sc-cell ${cls} ${i === s.cap - 1 ? "cap" : ""}" title="${fmt(d, { weekday: "short", day: "numeric", month: "short" })} ${ses}${on ? " — on duty" : off ? " — can't come" : ""}"></span>`;
      }).join("")}</div>`;
    };

    const groups = GROUPS.map(([g, label]) => {
      const list = people.filter((s) => s.grade === g)
        .map((s) => ({ s, n: work[s.id]?.size || 0 }))
        .sort((a, b) => (b.n > b.s.cap) - (a.n > a.s.cap) || b.n - a.n || a.s.name.localeCompare(b.s.name));
      if (!list.length) return "";
      const busy = list.filter((x) => x.n > 0);
      const shown = showAll ? list : busy;
      const cap = list[0].s.cap;
      return `<section class="sc-group">
        <p class="sc-head"><b>${label}</b><span>limit ${cap} / week</span></p>
        ${shown.map(({ s, n }) => `<div class="sc-row ${n > s.cap ? "is-over" : ""}">
          <span class="sc-name" title="${esc(s.name)}">${esc(s.name)}</span>
          <span class="sc-n">${n}/${s.cap}</span>
          ${bar(s)}
        </div>`).join("") || `<p class="muted small">Nobody on duty this week.</p>`}
        ${!showAll && list.length > busy.length ? `<p class="muted small">+ ${list.length - busy.length} with no duties this week</p>` : ""}
      </section>`;
    }).join("");

    panel.innerHTML = `
      <div class="sc-week">
        <button class="btn light small" data-w="-1" ${wi === 0 ? "disabled" : ""} aria-label="Previous week"><i class="ti ti-chevron-left"></i></button>
        <b>Week of ${fmt(wk)} – ${fmt(add(wk, 4), { day: "numeric", month: "short", year: "numeric" })}</b>
        <button class="btn light small" data-w="1" ${wi === weeks.length - 1 ? "disabled" : ""} aria-label="Next week"><i class="ti ti-chevron-right"></i></button>
      </div>
      <p class="sc-summary ${over.length ? "bad" : "good"}">
        <i class="ti ${over.length ? "ti-alert-triangle" : "ti-circle-check"}"></i>
        ${over.length ? `${over.length} ${over.length > 1 ? "people are" : "person is"} over their weekly limit` : "Everyone is within their weekly limit"}
      </p>
      <p class="sc-legend small"><span class="sc-cell on"></span> on duty <span class="sc-cell over on"></span> over limit
        <span class="sc-cell off"></span> can't come <span class="sc-cell beyond"></span> above limit</p>
      <label class="check small"><input type="checkbox" data-all ${showAll ? "checked" : ""}> Show people with no duties</label>
      ${groups}`;
  }

  panel.addEventListener("click", (e) => {
    const b = e.target.closest("[data-w]");
    if (!b) return;
    wi = Math.min(weeks.length - 1, Math.max(0, wi + Number(b.dataset.w)));
    onWeek(weeks[wi]);
    draw();
  });
  panel.addEventListener("change", (e) => { if (e.target.matches("[data-all]")) { showAll = e.target.checked; draw(); } });
  draw();
}
