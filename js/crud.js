// =====================================================================
// One engine for every admin section: list, search, add, edit, hold,
// delete, CSV template download and CSV import.
// The sections themselves are described in admin-data.js.
// =====================================================================
import { supabase } from "./config.js";
import { SECTIONS, REFS } from "./admin-data.js";
import Papa from "https://cdn.jsdelivr.net/npm/papaparse@5.4.1/+esm";

// ---------- small helpers ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function toast(text, kind = "ok") {
  document.querySelectorAll(".toast").forEach((old) => old.remove());
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4000);
}

// Turn database errors into plain English
function friendly(err) {
  const m = err?.message || String(err);
  if (err?.code === "23503") return "This item is still used somewhere else (for example by modules or students). Put it on hold instead of deleting it.";
  if (err?.code === "23505") return "An item with the same name/code/email already exists.";
  if (err?.code === "23514") return "One of the values is not allowed. Check the fields and try again.";
  if (err?.code === "42501") return "You don't have permission to do this. Are you logged in as admin?";
  return m;
}

// ---------- dropdown data for foreign keys (cached) ----------
const refCache = {};
async function loadRef(name, force = false) {
  if (refCache[name] && !force) return refCache[name];
  const r = REFS[name];
  const { data, error } = await supabase.from(r.table).select(r.select).order(r.order);
  if (error) throw error;
  refCache[name] = data.map((row) => ({ id: row.id, label: r.label(row), csvKey: r.csvKey ? r.csvKey(row) : null }));
  return refCache[name];
}
export function clearRefCache() { for (const k in refCache) delete refCache[k]; }

function displayValue(f, row, refs) {
  const v = row[f.key];
  if (v === null || v === undefined || v === "") return '<span class="muted">—</span>';
  if (f.type === "checkbox") return v ? "Yes" : '<span class="muted">No</span>';
  if (f.type === "select") return esc((f.options.find((o) => o[0] === v) || [v, v])[1]);
  if (f.type === "fk") return esc(refs[f.ref]?.find((o) => o.id === v)?.label ?? `#${v}`);
  return esc(v);
}

// Convert a form/CSV value to what the database expects
function cast(f, raw) {
  if (f.type === "checkbox") {
    if (typeof raw === "boolean") return raw;
    return /^(true|yes|y|1)$/i.test(String(raw ?? "").trim());
  }
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  if (f.type === "number") { const n = Number(s); if (Number.isNaN(n)) throw new Error(`“${f.label}” must be a number`); return n; }
  if (f.lower) return s.toLowerCase();
  return s;
}

// =====================================================================
// Render one section into `root`
// =====================================================================
export async function renderSection(root, key) {
  const cfg = SECTIONS[key];
  const state = { rows: [], refs: {}, q: "", showHeld: true };

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h1 class="page-title">${esc(cfg.title)}</h1>
        <p class="page-sub">${esc(cfg.help)}</p>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" class="search" placeholder="Search ${esc(cfg.title.toLowerCase())}…" aria-label="Search">
      ${cfg.hold ? `<label class="check"><input type="checkbox" class="show-held" checked> Show items on hold</label>` : ""}
      <span class="spacer"></span>
      <button class="btn light" data-act="template">Download CSV template</button>
      <label class="btn light">Import CSV<input type="file" accept=".csv" class="csv-file" hidden></label>
      <button class="btn" data-act="add">+ Add</button>
    </div>
    <div class="table-wrap"><p class="loading">Loading…</p></div>
    <p class="count muted"></p>`;

  const wrap = root.querySelector(".table-wrap");
  const listFields = cfg.fields.filter((f) => f.list);

  async function load() {
    // load dropdown data needed by this section
    for (const f of cfg.fields.filter((f) => f.type === "fk")) state.refs[f.ref] = await loadRef(f.ref);
    const { data, error } = await supabase.from(cfg.table).select("*").order(cfg.order);
    if (error) { wrap.innerHTML = `<p class="msg show error">${esc(friendly(error))}</p>`; return; }
    state.rows = data;
    draw();
  }

  function draw() {
    const q = state.q.toLowerCase();
    const rows = state.rows.filter((r) =>
      (state.showHeld || !r.on_hold) &&
      (!q || listFields.some((f) => String(displayValue(f, r, state.refs)).toLowerCase().includes(q))));

    if (!state.rows.length) {
      wrap.innerHTML = `<div class="empty"><p><strong>Nothing here yet.</strong></p><p class="muted">Click “+ Add”, or download the CSV template, fill it in Excel and import it.</p></div>`;
      root.querySelector(".count").textContent = "";
      return;
    }
    wrap.innerHTML = `
      <table class="data">
        <thead><tr>${listFields.map((f) => `<th>${esc(f.label.replace(/ \(.*\)/, ""))}</th>`).join("")}${cfg.hold ? "<th>Status</th>" : ""}<th class="actions-col"></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="${r.on_hold ? "held" : ""}" data-pk="${esc(r[cfg.pk])}" tabindex="0" title="Click to see and edit all details">
            ${listFields.map((f) => `<td>${displayValue(f, r, state.refs)}</td>`).join("")}
            ${cfg.hold ? `<td>${r.on_hold ? '<span class="badge hold">On hold</span>' : '<span class="badge active">Active</span>'}</td>` : ""}
            <td class="actions">
              ${cfg.hold ? `<button class="link" data-act="hold">${r.on_hold ? "Release" : "Hold"}</button>` : ""}
              <button class="link danger" data-act="delete">Delete</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    root.querySelector(".count").textContent =
      `Showing ${rows.length} of ${state.rows.length}` + (cfg.hold ? ` · ${state.rows.filter((r) => r.on_hold).length} on hold` : "");
  }

  // ----- events -----
  root.querySelector(".search").addEventListener("input", (e) => { state.q = e.target.value; draw(); });
  root.querySelector(".show-held")?.addEventListener("change", (e) => { state.showHeld = e.target.checked; draw(); });
  root.querySelector('[data-act="add"]').addEventListener("click", () => openForm(null));
  root.querySelector('[data-act="template"]').addEventListener("click", downloadTemplate);
  root.querySelector(".csv-file").addEventListener("change", (e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ""; });

  wrap.addEventListener("click", async (e) => {
    const tr = e.target.closest("tr[data-pk]");
    if (!tr) return;
    const row = state.rows.find((r) => String(r[cfg.pk]) === tr.dataset.pk);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "hold") return toggleHold(row);
    if (act === "delete") return remove(row);
    openForm(row);                       // clicking anywhere else on the row opens details
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("tr[data-pk]")) e.target.click();
  });

  async function toggleHold(row) {
    const { error } = await supabase.from(cfg.table).update({ on_hold: !row.on_hold }).eq(cfg.pk, row[cfg.pk]);
    if (error) return toast(friendly(error), "error");
    toast(row.on_hold ? "Released — included in new timetables again." : "On hold — left out of new timetables.");
    load();
  }

  async function remove(row) {
    const name = row.full_name || row.name || row.code || row[cfg.pk];
    if (!confirm(`Delete “${name}”? This cannot be undone.${cfg.hold ? "\n\nTip: use Hold if you only want to leave it out for now." : ""}`)) return;
    const { error } = await supabase.from(cfg.table).delete().eq(cfg.pk, row[cfg.pk]);
    if (error) return toast(friendly(error), "error");
    toast("Deleted.");
    clearRefCache();
    load();
  }

  // ----- add / edit form (a pop-up dialog) -----
  function openForm(row) {
    const dlg = document.createElement("dialog");
    dlg.className = "form-dialog";
    const isNew = !row;
    dlg.innerHTML = `
      <form method="dialog">
        <h2>${isNew ? "Add" : "Edit"} ${esc(cfg.singular)}</h2>
        <div class="grid">
          ${cfg.fields.map((f) => fieldHtml(f, row, isNew)).join("")}
        </div>
        <p class="msg error form-msg"></p>
        <div class="dialog-actions">
          <button type="button" class="btn light" value="cancel">Cancel</button>
          <button type="submit" class="btn">${isNew ? "Add" : "Save changes"}</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('[value="cancel"]').onclick = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove());

    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = dlg.querySelector(".form-msg");
      const record = {};
      try {
        for (const f of cfg.fields) {
          const el = dlg.querySelector(`[name="${f.key}"]`);
          if (!el) continue;
          const v = f.type === "checkbox" ? el.checked : cast(f, el.value);
          if (f.required && (v === null || v === "")) throw new Error(`Please fill in “${f.label}”.`);
          record[f.key] = f.type === "fk" && v !== null ? Number(v) : v;
        }
      } catch (err) { msg.textContent = err.message; msg.classList.add("show"); return; }

      const q = isNew
        ? supabase.from(cfg.table).insert(record)
        : supabase.from(cfg.table).update(record).eq(cfg.pk, row[cfg.pk]);
      const { error } = await q;
      if (error) { msg.textContent = friendly(error); msg.classList.add("show"); return; }
      dlg.close();
      toast(isNew ? "Added." : "Saved.");
      clearRefCache();
      load();
    });
  }

  function fieldHtml(f, row, isNew) {
    const v = row ? row[f.key] : (f.type === "checkbox" ? false : "");
    const req = f.required ? "required" : "";
    const lockPk = !isNew && f.key === cfg.pk && cfg.pkEditable ? "readonly" : "";
    const id = `f-${f.key}`;
    if (f.type === "checkbox") {
      return `<label class="check wide"><input type="checkbox" name="${f.key}" ${v ? "checked" : ""}> ${esc(f.label)}</label>`;
    }
    let input;
    if (f.type === "select" || f.type === "fk") {
      const opts = f.type === "select" ? f.options.map(([val, lab]) => ({ id: val, label: lab })) : state.refs[f.ref] || [];
      input = `<select id="${id}" name="${f.key}" ${req}>
        <option value="">— choose —</option>
        ${opts.map((o) => `<option value="${esc(o.id)}" ${String(o.id) === String(v ?? "") ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
      </select>`;
    } else {
      const type = { number: "number", email: "email", date: "date" }[f.type] || "text";
      input = `<input id="${id}" name="${f.key}" type="${type}" value="${esc(v ?? "")}" ${req} ${lockPk} ${f.step ? `step="${f.step}"` : ""}>`;
    }
    return `<div><label for="${id}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}</div>`;
  }

  // ----- CSV -----
  function csvHeaders() { return cfg.fields.map((f) => f.csv || f.key).concat(cfg.hold ? ["on_hold"] : []); }

  function downloadTemplate() {
    const headers = csvHeaders();
    const example = { ...cfg.example, on_hold: "false" };
    const csv = Papa.unparse({ fields: headers, data: [headers.map((h) => example[h] ?? "")] });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `${cfg.table}_template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importCsv(file) {
    const parsed = await new Promise((res) => Papa.parse(file, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim(), complete: res }));
    const rows = parsed.data;
    if (!rows.length) return toast("The file has no rows.", "error");

    // fresh dropdown data so new departments/batches can be matched
    clearRefCache();
    for (const f of cfg.fields.filter((f) => f.type === "fk")) state.refs[f.ref] = await loadRef(f.ref, true);

    const records = [], problems = [];
    rows.forEach((r, i) => {
      try {
        const rec = {};
        for (const f of cfg.fields) {
          const col = f.csv || f.key;
          if (!(col in r)) { if (f.required) throw new Error(`missing column “${col}”`); continue; }
          if (f.type === "fk") {
            const raw = String(r[col] ?? "").trim().toLowerCase();
            if (!raw) { if (f.required) throw new Error(`“${col}” is empty`); rec[f.key] = null; continue; }
            const hit = state.refs[f.ref].find((o) =>
              String(o.id) === raw || o.label.toLowerCase() === raw || (o.csvKey && o.csvKey.toLowerCase() === raw));
            if (!hit) throw new Error(`no ${SECTIONS[f.ref]?.singular || "item"} matches “${r[col]}”`);
            rec[f.key] = hit.id;
          } else {
            const v = cast(f, r[col]);
            if (f.required && (v === null || v === "")) throw new Error(`“${col}” is empty`);
            if (f.type === "select" && v !== null && !f.options.some((o) => o[0] === v))
              throw new Error(`“${v}” is not a valid ${f.label.toLowerCase()} (use ${f.options.map((o) => o[0]).join(", ")})`);
            rec[f.key] = v;
          }
        }
        if (cfg.hold && "on_hold" in r) rec.on_hold = cast({ type: "checkbox" }, r.on_hold);
        records.push(rec);
      } catch (err) { problems.push(`Row ${i + 2}: ${err.message}`); }
    });

    if (problems.length) {
      alert(`Nothing was imported. Please fix these rows and try again:\n\n${problems.slice(0, 15).join("\n")}${problems.length > 15 ? `\n…and ${problems.length - 15} more` : ""}`);
      return;
    }
    // upsert = add new rows, update existing ones (matched by name/code/email)
    const { error } = await supabase.from(cfg.table).upsert(records, { onConflict: cfg.conflict });
    if (error) return toast(friendly(error), "error");
    toast(`Imported ${records.length} row${records.length === 1 ? "" : "s"}.`);
    clearRefCache();
    load();
  }

  await load();
}

// =====================================================================
// Overview page (counts + Generate button)
// =====================================================================
export async function renderOverview(root, onNavigate) {
  root.innerHTML = `
    <h1 class="page-title">Exam timetable</h1>
    <p class="page-sub">Keep the data on the left up to date, then generate the timetable.</p>
    <div class="generate-card">
      <div>
        <h2>Generate timetable</h2>
        <p>Pick the exam period and what to include. The system plans dates, halls, supervisors, invigilators and seats.</p>
      </div>
      <button class="btn big" id="generate" disabled title="Coming in the next step">Generate timetable</button>
    </div>
    <h2 class="sub-head">Data at a glance</h2>
    <div class="stats"><p class="loading">Counting…</p></div>`;

  const items = [
    ["lecturers", "Lecturers"], ["rooms", "Classes"], ["modules", "Modules"],
    ["batches", "Batches"], ["students", "Students"], ["holidays", "Holidays"], ["departments", "Departments"],
  ];
  const counts = await Promise.all(items.map(async ([k]) => {
    const t = SECTIONS[k].table;
    const all = await supabase.from(t).select("*", { count: "exact", head: true });
    const held = SECTIONS[k].hold
      ? await supabase.from(t).select("*", { count: "exact", head: true }).eq("on_hold", true)
      : { count: 0 };
    return { all: all.count ?? 0, held: held.count ?? 0 };
  }));
  root.querySelector(".stats").innerHTML = items.map(([k, label], i) => `
    <button class="stat" data-go="${k}">
      <span class="num">${counts[i].all}</span>
      <span class="lab">${label}</span>
      ${counts[i].held ? `<span class="held-note">${counts[i].held} on hold</span>` : ""}
    </button>`).join("");
  root.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => onNavigate(b.dataset.go)));
}
