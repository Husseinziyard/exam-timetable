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
  refCache[name] = data.map((row) => ({
    id: row.id, label: r.label(row),
    keys: [String(row.id), r.label(row), ...(r.csvKeys ? r.csvKeys(row) : [])]
      .filter(Boolean).map((k) => String(k).trim().toLowerCase()),
  }));
  return refCache[name];
}
export function clearRefCache() { for (const k in refCache) delete refCache[k]; }

function displayValue(f, row, refs) {
  const v = row[f.key];
  if (v === null || v === undefined || v === "") return '<span class="muted">—</span>';
  if (f.type === "checkbox") return v ? "Yes" : '<span class="muted">No</span>';
  if (f.type === "select") return esc((f.options.find((o) => o[0] === v) || [v, v])[1]);
  if (f.type === "fk") return esc(refs[f.ref]?.find((o) => o.id === v)?.label ?? `#${v}`);
  if (f.type === "multi") {
    if (!v.length) return '<span class="muted">—</span>';
    return v.map((id) => esc((refs[f.ref]?.find((o) => o.id === id)?.label ?? `#${id}`).replace(/^Intake /, ""))).join(", ");
  }
  return esc(v);
}

// Convert a form/CSV value to what the database expects
function cast(f, raw) {
  if (f.type === "checkbox") {
    if (typeof raw === "boolean") return raw;
    if (f.auto && String(raw ?? "").trim() === "") return undefined;   // let the database fill it from the grade
    return /^(true|yes|y|1)$/i.test(String(raw ?? "").trim());
  }
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  if (f.type === "number") { const n = Number(s); if (Number.isNaN(n)) throw new Error(`“${f.label}” must be a number`); return n; }
  if (f.lower) return s.toLowerCase();
  return s;
}

function findRef(options, raw) {
  const k = String(raw ?? "").trim().toLowerCase();
  return options.find((o) => o.keys.includes(k));
}

// Save the ticked items of a "multi" field into its link table
async function saveLinks(f, ownerIds, idsByOwner) {
  if (!ownerIds.length) return;
  let { error } = await supabase.from(f.link).delete().in(f.linkKey, ownerIds);
  if (error) throw error;
  const rows = ownerIds.flatMap((oid) => (idsByOwner[oid] || []).map((rid) => ({ [f.linkKey]: oid, [f.linkRef]: rid })));
  if (rows.length) ({ error } = await supabase.from(f.link).insert(rows));
  if (error) throw error;
}

// =====================================================================
// Render one section into `root`
// =====================================================================
export async function renderSection(root, key) {
  const cfg = SECTIONS[key];
  // colFilters: { fieldKey: { op: "contains" | "equals" | "starts" | "not", value: "text" } }
  const state = { rows: [], refs: {}, q: "", showHeld: true, colFilters: {}, sort: null, selected: new Set(), visible: [] };

  root.innerHTML = `
    <div class="section-head">
      <div>
        <h1 class="page-title">${esc(cfg.title)}</h1>
        <p class="page-sub">${esc(cfg.help)}</p>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" class="search" placeholder="Search all columns…" aria-label="Search">
      ${cfg.hold ? `<label class="check"><input type="checkbox" class="show-held" checked> Show items on hold</label>` : ""}
      <span class="spacer"></span>
      <button class="btn light" data-act="template">Download CSV template</button>
      <label class="btn light">Import CSV<input type="file" accept=".csv" class="csv-file" hidden></label>
      <button class="btn" data-act="add">+ Add</button>
    </div>
    <div class="chips"></div>
    <div class="bulkbar" hidden role="region" aria-label="Selected items">
      <span class="bulk-count"></span>
      ${cfg.hold ? `<button class="btn light small" data-bulk="hold"><i class="ti ti-player-pause"></i> Hold</button>
      <button class="btn light small" data-bulk="release"><i class="ti ti-player-play"></i> Release</button>` : ""}
      <button class="btn light small danger-btn" data-bulk="delete"><i class="ti ti-trash"></i> Delete</button>
      <button class="link" data-bulk="clear">Clear selection</button>
    </div>
    <div class="table-wrap"><p class="loading">Loading…</p></div>
    <p class="count muted"></p>`;

  const wrap = root.querySelector(".table-wrap");
  const chips = root.querySelector(".chips");
  const listFields = cfg.fields.filter((f) => f.list);
  const plain = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
  const cellText = (f, r) => {
    const t = plain(displayValue(f, r, state.refs));
    return t === "—" ? "" : t;
  };
  const OPS = { contains: "contains", equals: "equals", starts: "starts with", not: "doesn't contain" };
  const shortLabel = (f) => f.label.replace(/ \(.*\)/, "");

  function passesFilters(r) {
    return Object.entries(state.colFilters).every(([k, { op, value }]) => {
      const f = cfg.fields.find((x) => x.key === k);
      const t = cellText(f, r).toLowerCase(), v = value.toLowerCase();
      if (op === "equals") return f.type === "multi" ? t.split(", ").includes(v) : t === v;
      if (op === "starts") return t.startsWith(v);
      if (op === "not") return !t.includes(v);
      return t.includes(v);
    });
  }

  function sortRows(rows) {
    if (!state.sort) return rows;
    const f = cfg.fields.find((x) => x.key === state.sort.key);
    const val = (r) => (f.type === "number" ? (r[f.key] ?? -Infinity) : cellText(f, r).toLowerCase());
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return state.sort.dir * c;
    });
  }

  async function load() {
    // load dropdown data needed by this section
    for (const f of cfg.fields.filter((f) => f.ref)) state.refs[f.ref] = await loadRef(f.ref);
    const { data, error } = await supabase.from(cfg.table).select("*").order(cfg.order);
    if (error) { wrap.innerHTML = `<p class="msg show error">${esc(friendly(error))}</p>`; return; }
    for (const f of cfg.fields.filter((f) => f.type === "multi")) {
      const { data: links, error: e2 } = await supabase.from(f.link).select("*");
      if (e2) { wrap.innerHTML = `<p class="msg show error">${esc(friendly(e2))}</p>`; return; }
      data.forEach((row) => { row[f.key] = links.filter((l) => l[f.linkKey] === row[cfg.pk]).map((l) => l[f.linkRef]); });
    }
    state.rows = data;
    draw();
  }

  function drawChips() {
    const active = Object.entries(state.colFilters);
    chips.innerHTML = active.map(([k, { op, value }]) => {
      const f = cfg.fields.find((x) => x.key === k);
      return `<span class="chip">${esc(shortLabel(f))} ${OPS[op]} “${esc(value)}”
        <button class="chip-x" data-remove="${k}" aria-label="Remove filter">×</button></span>`;
    }).join("") + (active.length > 1 ? `<button class="link" data-remove="*">Clear all</button>` : "");
  }

  function draw() {
    drawChips();
    const q = state.q.toLowerCase();
    const rows = sortRows(state.rows.filter((r) =>
      (state.showHeld || !r.on_hold) && passesFilters(r) &&
      (!q || listFields.some((f) => cellText(f, r).toLowerCase().includes(q)))));

    if (!state.rows.length) {
      wrap.innerHTML = `<div class="empty"><p><strong>Nothing here yet.</strong></p><p class="muted">Click “+ Add”, or download the CSV template, fill it in Excel and import it.</p></div>`;
      root.querySelector(".count").textContent = "";
      return;
    }
    state.visible = rows.map((r) => String(r[cfg.pk]));
    const allOn = rows.length > 0 && state.visible.every((k) => state.selected.has(k));
    wrap.innerHTML = `
      <table class="data">
        <thead><tr><th class="sel-col"><input type="checkbox" class="sel-all" aria-label="Select all shown rows" ${allOn ? "checked" : ""}></th>${listFields.map((f) => {
          const sorted = state.sort?.key === f.key, filtered = !!state.colFilters[f.key];
          return `<th class="${filtered ? "filtered" : ""}" aria-sort="${sorted ? (state.sort.dir > 0 ? "ascending" : "descending") : "none"}">
            <div class="th-inner"><span>${esc(shortLabel(f))}${sorted ? (state.sort.dir > 0 ? " ▲" : " ▼") : ""}${filtered ? ' <span class="dot" title="Filtered"></span>' : ""}</span>
            <button class="colmenu" data-col="${f.key}" aria-label="Sort or filter ${esc(shortLabel(f))}" aria-haspopup="true"><i class="ti ti-dots-vertical" aria-hidden="true"></i></button></div></th>`;
        }).join("")}${cfg.hold ? "<th>Status</th>" : ""}<th class="actions-col"></th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="${r.on_hold ? "held" : ""} ${state.selected.has(String(r[cfg.pk])) ? "selected" : ""}" data-pk="${esc(r[cfg.pk])}" tabindex="0" title="Click to see and edit all details">
            <td class="sel-col"><input type="checkbox" class="sel" aria-label="Select this row" ${state.selected.has(String(r[cfg.pk])) ? "checked" : ""}></td>
            ${listFields.map((f) => `<td>${displayValue(f, r, state.refs)}</td>`).join("")}
            ${cfg.hold ? `<td>${r.on_hold ? '<span class="badge hold">On hold</span>' : '<span class="badge active">Active</span>'}</td>` : ""}
            <td class="actions">
              ${cfg.hold ? `<button class="link" data-act="hold">${r.on_hold ? "Release" : "Hold"}</button>` : ""}
              <button class="link danger" data-act="delete">Delete</button>
            </td>
          </tr>`).join("") || `<tr><td colspan="${listFields.length + 3}" class="muted" style="text-align:center;padding:32px">Nothing matches these filters.</td></tr>`}
        </tbody>
      </table>`;
    root.querySelector(".count").textContent =
      `Showing ${rows.length} of ${state.rows.length}` + (cfg.hold ? ` · ${state.rows.filter((r) => r.on_hold).length} on hold` : "");
    const some = !allOn && state.visible.some((k) => state.selected.has(k));
    const head = wrap.querySelector(".sel-all");
    if (head) head.indeterminate = some;
    drawBulkbar();
  }

  // ----- selecting several rows -----
  function drawBulkbar() {
    const bar = root.querySelector(".bulkbar");
    const n = state.selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    const hidden = [...state.selected].filter((k) => !state.visible.includes(k)).length;
    bar.querySelector(".bulk-count").textContent =
      `${n} selected` + (hidden ? ` (${hidden} not shown by the current filters)` : "");
  }

  async function bulk(action) {
    if (action === "clear") { state.selected.clear(); return draw(); }
    let rows = state.rows.filter((r) => state.selected.has(String(r[cfg.pk])));
    if (!rows.length) return;
    // safety: never hold or delete admin accounts in bulk (so nobody locks themselves out)
    let skipped = 0;
    if (cfg.table === "lecturers" && action !== "release") {
      skipped = rows.filter((r) => r.is_admin).length;
      rows = rows.filter((r) => !r.is_admin);
      if (!rows.length) return toast("Admin accounts can't be held or deleted in bulk.", "error");
    }
    const ids = rows.map((r) => r[cfg.pk]);
    const what = `${ids.length} ${ids.length === 1 ? cfg.singular : (cfg.title.toLowerCase())}`;
    if (action === "delete" && !confirm(`Delete ${what}? This cannot be undone.` +
      (cfg.hold ? "\n\nTip: use Hold if you only want to leave them out for now." : ""))) return;

    let failed = 0;
    if (action === "hold" || action === "release") {
      const { error } = await supabase.from(cfg.table).update({ on_hold: action === "hold" }).in(cfg.pk, ids);
      if (error) return toast(friendly(error), "error");
    } else {
      const { error } = await supabase.from(cfg.table).delete().in(cfg.pk, ids);
      if (error?.code === "23503") {
        // some are still in use: delete the ones we can, keep the rest
        for (const id of ids) {
          const { error: e1 } = await supabase.from(cfg.table).delete().eq(cfg.pk, id);
          if (e1) failed++;
        }
      } else if (error) return toast(friendly(error), "error");
      clearRefCache();
    }
    const done = ids.length - failed;
    const verb = { hold: "put on hold", release: "released", delete: "deleted" }[action];
    toast(`${done} ${verb}.` +
      (failed ? ` ${failed} could not be deleted because they are still used elsewhere — hold them instead.` : "") +
      (skipped ? ` ${skipped} admin account${skipped > 1 ? "s" : ""} skipped.` : ""), failed ? "error" : "ok");
    state.selected.clear();
    load();
  }

  // ----- the ⋮ column menu: sort + filter -----
  function closeMenu() { document.querySelector(".col-pop")?.remove(); }

  function openMenu(btn) {
    closeMenu();
    const f = cfg.fields.find((x) => x.key === btn.dataset.col);
    const cur = state.colFilters[f.key] || { op: f.type === "select" || f.type === "fk" || f.type === "checkbox" ? "equals" : "contains", value: "" };
    // suggestions = the values that exist in this column
    const values = [...new Set(state.rows.flatMap((r) =>
      f.type === "multi" ? cellText(f, r).split(", ") : [cellText(f, r)]).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, 200);

    const pop = document.createElement("div");
    pop.className = "col-pop";
    pop.setAttribute("role", "dialog");
    pop.innerHTML = `
      <p class="pop-title">${esc(shortLabel(f))}</p>
      <button class="pop-item" data-sort="1">↑ Sort A → Z</button>
      <button class="pop-item" data-sort="-1">↓ Sort Z → A</button>
      ${state.sort?.key === f.key ? `<button class="pop-item" data-sort="0">Remove sort</button>` : ""}
      <hr>
      <p class="pop-title">Filter</p>
      <select class="pop-op" aria-label="Condition">
        ${Object.entries(OPS).map(([k, l]) => `<option value="${k}" ${k === cur.op ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <input class="pop-val" list="vals-${f.key}" placeholder="Type or pick a value" value="${esc(cur.value)}" aria-label="Value">
      <datalist id="vals-${f.key}">${values.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>
      ${values.length && values.length <= 12 ? `<div class="pop-values">${values.map((v) =>
        `<button class="pop-chip" data-pick="${esc(v)}">${esc(v)}</button>`).join("")}</div>` : ""}
      <div class="pop-actions">
        ${state.colFilters[f.key] ? `<button class="btn light small" data-clear>Clear</button>` : ""}
        <button class="btn small" data-apply>Apply</button>
      </div>`;
    document.body.appendChild(pop);

    // place it under the ⋮ button, kept inside the window
    const b = btn.getBoundingClientRect();
    const left = Math.min(b.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - pop.offsetWidth - 12);
    pop.style.left = `${Math.max(12, left)}px`;
    pop.style.top = `${b.bottom + window.scrollY + 6}px`;
    const input = pop.querySelector(".pop-val");
    input.focus();

    const apply = () => {
      const value = input.value.trim();
      if (value) state.colFilters[f.key] = { op: pop.querySelector(".pop-op").value, value };
      else delete state.colFilters[f.key];
      closeMenu(); draw();
    };
    pop.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.sort !== undefined) {
        const d = Number(t.dataset.sort);
        state.sort = d ? { key: f.key, dir: d } : null;
        closeMenu(); draw();
      } else if (t.dataset.pick !== undefined) {
        input.value = t.dataset.pick;
        pop.querySelector(".pop-op").value = "equals";
        apply();
      } else if (t.hasAttribute("data-clear")) {
        delete state.colFilters[f.key]; closeMenu(); draw();
      } else if (t.hasAttribute("data-apply")) apply();
    });
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      if (e.key === "Escape") { closeMenu(); btn.focus(); }
    });
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".col-pop") && !e.target.closest(".colmenu")) closeMenu();
  });

  // ----- events -----
  root.querySelector(".search").addEventListener("input", (e) => { state.q = e.target.value; draw(); });
  root.querySelector(".show-held")?.addEventListener("change", (e) => { state.showHeld = e.target.checked; draw(); });
  chips.addEventListener("click", (e) => {
    const k = e.target.dataset.remove;
    if (!k) return;
    if (k === "*") state.colFilters = {}; else delete state.colFilters[k];
    draw();
  });
  root.querySelector('[data-act="add"]').addEventListener("click", () => openForm(null));
  root.querySelector('[data-act="template"]').addEventListener("click", downloadTemplate);
  root.querySelector(".csv-file").addEventListener("change", (e) => { if (e.target.files[0]) importCsv(e.target.files[0]); e.target.value = ""; });

  root.querySelector(".bulkbar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (b) bulk(b.dataset.bulk);
  });
  wrap.addEventListener("change", (e) => {
    if (e.target.matches(".sel-all")) {
      state.visible.forEach((k) => (e.target.checked ? state.selected.add(k) : state.selected.delete(k)));
      return draw();
    }
    if (e.target.matches(".sel")) {
      const k = e.target.closest("tr").dataset.pk;
      e.target.checked ? state.selected.add(k) : state.selected.delete(k);
      e.target.closest("tr").classList.toggle("selected", e.target.checked);
      const head = wrap.querySelector(".sel-all");
      const all = state.visible.every((x) => state.selected.has(x));
      head.checked = all;
      head.indeterminate = !all && state.visible.some((x) => state.selected.has(x));
      drawBulkbar();
    }
  });

  wrap.addEventListener("click", async (e) => {
    if (e.target.closest(".sel-col")) return;    // ticking a box doesn't open the details
    const menuBtn = e.target.closest(".colmenu");
    if (menuBtn) { e.stopPropagation(); return openMenu(menuBtn); }
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

    // New records: tick "auto" checkboxes based on the other fields (e.g. grade)
    const autos = cfg.fields.filter((f) => f.auto);
    if (isNew && autos.length) {
      const refresh = () => {
        const rec = Object.fromEntries(cfg.fields.map((f) => [f.key, dlg.querySelector(`[name="${f.key}"]`)?.value]));
        autos.forEach((f) => { dlg.querySelector(`[name="${f.key}"]`).checked = f.auto(rec); });
      };
      dlg.querySelector("form").addEventListener("change", (e) => { if (!autos.some((f) => f.key === e.target.name)) refresh(); });
    }
    dlg.addEventListener("close", () => dlg.remove());

    dlg.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const msg = dlg.querySelector(".form-msg");
      const record = {}, multis = {};
      try {
        for (const f of cfg.fields) {
          if (f.type === "multi") {
            const ids = [...dlg.querySelectorAll(`[name="${f.key}"]:checked`)].map((el) => Number(el.value));
            if (f.required && !ids.length) throw new Error(`Please tick at least one in “${f.label}”.`);
            multis[f.key] = ids;
            continue;
          }
          const el = dlg.querySelector(`[name="${f.key}"]`);
          if (!el) continue;
          const v = f.type === "checkbox" ? el.checked : cast(f, el.value);
          if (f.required && (v === null || v === "")) throw new Error(`Please fill in “${f.label}”.`);
          record[f.key] = f.type === "fk" && v !== null ? Number(v) : v;
        }
      } catch (err) { msg.textContent = err.message; msg.classList.add("show"); return; }

      const q = isNew
        ? supabase.from(cfg.table).insert(record).select(cfg.pk).single()
        : supabase.from(cfg.table).update(record).eq(cfg.pk, row[cfg.pk]).select(cfg.pk).single();
      const { data: saved, error } = await q;
      if (error) { msg.textContent = friendly(error); msg.classList.add("show"); return; }
      try {
        for (const f of cfg.fields.filter((f) => f.type === "multi"))
          await saveLinks(f, [saved[cfg.pk]], { [saved[cfg.pk]]: multis[f.key] });
      } catch (err) { msg.textContent = friendly(err); msg.classList.add("show"); return; }
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
    if (f.type === "multi") {
      const chosen = new Set(v || []);
      const opts = state.refs[f.ref] || [];
      return `<div class="wide"><label>${esc(f.label)}${f.required ? " *" : ""}</label>
        <div class="multi">${opts.length ? opts.map((o) => `
          <label class="check"><input type="checkbox" name="${f.key}" value="${o.id}" ${chosen.has(o.id) ? "checked" : ""}> ${esc(o.label)}</label>`).join("")
          : '<p class="muted">Nothing to choose yet. Add batches first.</p>'}</div></div>`;
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
    for (const f of cfg.fields.filter((f) => f.ref)) state.refs[f.ref] = await loadRef(f.ref, true);

    const records = [], problems = [], multiByRow = [];
    rows.forEach((r, i) => {
      try {
        const rec = {}, multi = {};
        for (const f of cfg.fields) {
          const col = f.csv || f.key;
          if (!(col in r)) { if (f.required) throw new Error(`missing column “${col}”`); continue; }
          if (f.type === "multi") {
            const parts = String(r[col] ?? "").split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
            if (f.required && !parts.length) throw new Error(`“${col}” is empty`);
            multi[f.key] = parts.map((x) => {
              const hit = findRef(state.refs[f.ref], x);
              if (!hit) throw new Error(`no ${SECTIONS[f.ref]?.singular || "item"} matches “${x}”`);
              return hit.id;
            });
          } else if (f.type === "fk") {
            const raw = String(r[col] ?? "").trim();
            if (!raw) { if (f.required) throw new Error(`“${col}” is empty`); rec[f.key] = null; continue; }
            const hit = findRef(state.refs[f.ref], raw);
            if (!hit) throw new Error(`no ${SECTIONS[f.ref]?.singular || "item"} matches “${raw}”`);
            rec[f.key] = hit.id;
          } else {
            const v = cast(f, r[col]);
            if (v === undefined) continue;
            if (f.required && (v === null || v === "")) throw new Error(`“${col}” is empty`);
            if (f.type === "select" && v !== null && !f.options.some((o) => o[0] === v))
              throw new Error(`“${v}” is not a valid ${f.label.toLowerCase()} (use ${f.options.map((o) => o[0]).join(", ")})`);
            rec[f.key] = v;
          }
        }
        if (cfg.hold && "on_hold" in r) rec.on_hold = cast({ type: "checkbox" }, r.on_hold);
        records.push(rec);
        multiByRow.push(multi);
      } catch (err) { problems.push(`Row ${i + 2}: ${err.message}`); }
    });

    if (problems.length) {
      alert(`Nothing was imported. Please fix these rows and try again:\n\n${problems.slice(0, 15).join("\n")}${problems.length > 15 ? `\n…and ${problems.length - 15} more` : ""}`);
      return;
    }
    // upsert = add new rows, update existing ones (matched by name/code/email)
    const { data: saved, error } = await supabase.from(cfg.table).upsert(records, { onConflict: cfg.conflict }).select();
    if (error) return toast(friendly(error), "error");
    // link tables (e.g. which streams sit each module): match saved rows back by the conflict key
    try {
      const keyCols = cfg.conflict.split(",");
      const keyOf = (o) => keyCols.map((k) => String(o[k] ?? "").toLowerCase()).join("|");
      for (const f of cfg.fields.filter((f) => f.type === "multi")) {
        const byOwner = {}, owners = [];
        records.forEach((rec, i) => {
          const hit = saved.find((s) => keyOf(s) === keyOf(rec));
          if (hit && multiByRow[i][f.key]) { owners.push(hit[cfg.pk]); byOwner[hit[cfg.pk]] = multiByRow[i][f.key]; }
        });
        await saveLinks(f, owners, byOwner);
      }
    } catch (err) { return toast(friendly(err), "error"); }
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
    ["lecturers", "Staff"], ["rooms", "Classes"], ["modules", "Modules"],
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
