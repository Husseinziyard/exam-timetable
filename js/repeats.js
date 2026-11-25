// =====================================================================
// Repeat students — entered per exam period (they change every time).
//
// One row = "N students of a stream repeat a paper":
//   module_code   the paper they repeat
//   module_name   only needed for an old paper that isn't in Modules
//   stream        the stream they sit with (MTS, LM, BSM…)
//   repeats       how many students
//   sit_with      (old papers) the current paper they sit with — same time, same hall
//   duration      (old papers) hours, e.g. 2
//
// Two cases:
//   • same paper as the batch this time  -> just adds to that paper's count (P42 + R15)
//   • any other paper (old code, other semester) -> an "attached" paper, sat at the same
//     time and in the same hall as its sit_with paper (shown in italics on the sheet)
// Stored on the timetable: exam_periods.options.repeats
// =====================================================================
import { supabase } from "./config.js";

const norm = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const tight = (s) => norm(s).replace(/[\s-]/g, "");          // "MGT 120202" = "MGT120202" = "mgt-120202"
export const REPEAT_COLS = ["module_code", "module_name", "stream", "repeats", "sit_with", "duration"];

// Clean rows from a file or the table
const tidyRow = (r) => ({
    module_code: norm(r.module_code ?? r.code),
    module_name: String(r.module_name ?? r.name ?? "").trim(),
    stream: norm(r.stream),
    repeats: Math.max(0, Math.round(Number(r.repeats ?? r.count ?? 0)) || 0),
    sit_with: norm(r.sit_with),
    duration: Number(r.duration) || null,
});
const complete = (r) => r.module_code && r.repeats > 0;
export function cleanRepeats(rows) {
  return (rows || []).map(tidyRow).filter(complete);
}

// Repeats per paper code: { "MGT120202": 15 }
export function repeatCounts(rows) {
  const out = {};
  cleanRepeats(rows).forEach((r) => { out[tight(r.module_code)] = (out[tight(r.module_code)] || 0) + r.repeats; });
  return out;
}

// Module copies whose repeat count comes from this period's list (when the list mentions them)
export function withRepeats(modules, rows) {
  const c = repeatCounts(rows);
  if (!Object.keys(c).length) return modules;
  return modules.map((m) => (c[tight(m.code)] != null ? { ...m, repeat_students: c[tight(m.code)] } : m));
}

// Work out what each row means for the papers chosen this time.
//   mods:       modules in this timetable   batchesOf: { moduleId: [batchIds] }   batchById
//   allModules: the whole Modules list (to find old papers that already exist)
// Returns rows with a .status / .kind / .hostCode, plus problems.
export function resolveRepeats(rows, { mods, batchesOf, batchById, allModules }) {
  const byCode = Object.fromEntries(mods.map((m) => [tight(m.code), m]));
  const anyByCode = Object.fromEntries(allModules.map((m) => [tight(m.code), m]));
  const streamOf = (m) => (batchesOf[m.id] || []).map((b) => norm(batchById[b]?.stream));
  return cleanRepeats(rows).map((r) => {
    const same = byCode[tight(r.module_code)];
    if (same) {
      const sits = streamOf(same).includes(r.stream) || !r.stream;
      return { ...r, kind: "same", hostCode: same.code,
        status: `Adds ${r.repeats} to ${same.code}${sits ? "" : ` (${r.stream} isn't sitting it this time — still counted)`}`, ok: true };
    }
    // an old / other paper: needs a current paper to sit with
    let host = r.sit_with ? byCode[tight(r.sit_with)] : null;
    if (r.sit_with && !host) return { ...r, kind: "attach", ok: false, status: `“${r.sit_with}” isn't in this timetable` };
    if (!host) {     // no sit_with: the stream's paper with the most students (most likely the matching one)
      host = mods.filter((m) => streamOf(m).includes(r.stream) && !m.on_hold)
        .sort((a, b) => (batchesOf[b.id] || []).length - (batchesOf[a.id] || []).length || a.code.localeCompare(b.code))[0];
    }
    if (!host) return { ...r, kind: "attach", ok: false, status: `No paper of stream “${r.stream || "?"}” in this timetable — add sit_with` };
    const known = anyByCode[tight(r.module_code)];
    if (!known && !r.module_name) return { ...r, kind: "attach", ok: false, status: "Old paper: please add its module_name" };
    return { ...r, kind: "attach", hostCode: host.code, sit_with: r.sit_with || host.code, ok: true,
      status: `${known ? "" : "Old paper · "}sits with ${host.code}${r.sit_with ? "" : " (chosen automatically)"}` };
  });
}

// Make sure every attached paper exists in Modules (old codes are added, on hold, so they never
// show up as a normal paper of any semester). Returns { code -> module row }.
export async function ensureRepeatModules(resolved, allModules) {
  const anyByCode = Object.fromEntries(allModules.map((m) => [tight(m.code), m]));
  const out = {};
  for (const r of resolved.filter((x) => x.kind === "attach" && x.ok)) {
    let m = anyByCode[tight(r.module_code)];
    if (!m) {
      const { data, error } = await supabase.from("modules").insert({
        code: r.module_code, name: r.module_name, semester: 0, duration_hours: r.duration || 2,
        streams: r.stream ? [r.stream] : [], repeat_students: 0, expected_students: 0, audience: "all", on_hold: true,     // semester 0 + on hold = an old paper, never planned on its own
      }).select("*").single();
      if (error) throw new Error(`Couldn't add the old paper ${r.module_code}: ${error.message}`);
      m = data; anyByCode[tight(m.code)] = m; allModules.push(m);
    }
    out[tight(r.module_code)] = m;
  }
  return out;
}

// The modules to plan with: this timetable's papers (with repeat counts) + attached old papers.
// Attached papers get .sitWith = host module id, so the engine keeps them together.
export function planModules(mods, resolved, attachedByCode) {
  const counts = repeatCounts(resolved.filter((r) => r.ok));
  const base = mods.map((m) => (counts[tight(m.code)] != null ? { ...m, repeat_students: counts[tight(m.code)] } : m));
  const byCode = Object.fromEntries(base.map((m) => [tight(m.code), m]));
  const extra = [];
  for (const r of resolved.filter((x) => x.kind === "attach" && x.ok)) {
    const m = attachedByCode[tight(r.module_code)];
    const host = byCode[tight(r.hostCode)];
    if (!m || !host) continue;
    const prev = extra.find((x) => x.id === m.id);
    if (prev) { prev.repeat_students += r.repeats; continue; }
    extra.push({ ...m, expected_students: 0, repeat_students: r.repeats, sitWith: host.id, on_hold: false,
      duration_hours: r.duration || m.duration_hours });
  }
  return [...base, ...extra];
}

// ----- files -----
export function templateCsv() {
  return [REPEAT_COLS.join(","),
    "MGT 120202,,MTS,15,,",
    "MA 1212,Basic Calculus,MTS,1,MGT 120202,2",
    "SS 1262,Fundamentals of Statistics,SS,1,,2"].join("\n");
}

// Read a CSV or Excel (.xlsx) file into rows
export async function readRepeatFile(file) {
  const name = file.name.toLowerCase();
  let rows;
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    if (!window.XLSX) await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = ok; s.onerror = () => fail(new Error("Couldn't load the Excel reader. Save the file as CSV and try again."));
      document.head.appendChild(s);
    });
    const wb = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
  } else {
    const Papa = window.Papa || (await import("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/+esm")).default;
    rows = Papa.parse(await file.text(), { header: true, skipEmptyLines: true }).data;
  }
  // header names: "Module code", "module_code", "MODULE CODE" all work
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim().toLowerCase().replace(/[\s-]+/g, "_"), v])));
}

// ----- the table (used in the Generate pop-up and the Edit sidebar) -----
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function repeatsEditor(container, rows, { resolve, onChange }) {
  let list = cleanRepeats(rows);
  function draw() {
    // check the complete rows; half-filled rows stay visible with a hint
    const checked = resolve ? resolve(list.filter(complete)) : list.filter(complete);
    let k = 0;
    const res = list.map((r) => (complete(r) ? checked[k++] : { ...r, ok: false, status: "Fill in the paper code and the number of repeats" }));
    const bad = res.filter((r) => r.ok === false).length;
    const total = list.reduce((a, r) => a + r.repeats, 0);
    container.innerHTML = `
      <div class="rep-tools">
        <label class="btn light small"><i class="ti ti-upload"></i> Upload Excel / CSV<input type="file" accept=".csv,.xlsx,.xls" hidden data-rep-file></label>
        <button type="button" class="btn light small" data-rep-template><i class="ti ti-download"></i> Template</button>
        <button type="button" class="btn light small" data-rep-add><i class="ti ti-plus"></i> Add row</button>
        ${list.length ? `<button type="button" class="link small danger" data-rep-clear>Clear all</button>` : ""}
        <span class="muted small">${list.length ? `${list.length} rows · ${total} repeat students${bad ? ` · <span class="warn-text">${bad} to fix</span>` : ""}` : "No repeat students yet (you can add them later too)."}</span>
      </div>
      ${list.length ? `<div class="rep-table"><table class="data compact">
        <thead><tr><th>Paper code</th><th>Name (old papers)</th><th>Stream</th><th>Repeats</th><th>Sits with</th><th>Hours</th><th>What happens</th><th></th></tr></thead>
        <tbody>${res.map((r, i) => `<tr data-i="${i}" class="${r.ok === false ? "bad" : ""}">
          <td><input data-k="module_code" value="${esc(r.module_code)}"></td>
          <td><input data-k="module_name" value="${esc(r.module_name)}"></td>
          <td><input data-k="stream" value="${esc(r.stream)}" size="6"></td>
          <td><input data-k="repeats" type="number" min="1" value="${r.repeats}" style="width:64px"></td>
          <td><input data-k="sit_with" value="${esc(r.sit_with)}" placeholder="auto"></td>
          <td><input data-k="duration" type="number" min="1" max="3" value="${r.duration ?? ""}" style="width:56px"></td>
          <td class="small ${r.ok === false ? "warn-text" : "muted"}">${esc(r.status || "")}</td>
          <td><button type="button" class="link danger" data-rep-del="${i}" aria-label="Remove row"><i class="ti ti-x"></i></button></td></tr>`).join("")}</tbody>
      </table></div>` : ""}`;
    onChange?.(list, res);
  }
  container.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.matches("[data-rep-file]")) {
      try { list = [...list, ...cleanRepeats(await readRepeatFile(t.files[0]))]; draw(); }
      catch (err) { alert(err.message || String(err)); }
      return;
    }
    if (t.matches("[data-k]")) {
      const i = Number(t.closest("tr").dataset.i);
      list[i] = tidyRow({ ...list[i], [t.dataset.k]: t.value });
      draw();
    }
  });
  container.addEventListener("click", (e) => {
    if (e.target.closest("[data-rep-template]")) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([templateCsv()], { type: "text/csv" }));
      a.download = "repeat-students-template.csv"; a.click();
    }
    if (e.target.closest("[data-rep-add]")) {
      list.push({ module_code: "", module_name: "", stream: "", repeats: 1, sit_with: "", duration: null }); draw();
      container.querySelector("tbody tr:last-child input")?.focus();
    }
    if (e.target.closest("[data-rep-clear]") && confirm("Remove all repeat rows?")) { list = []; draw(); }
    const del = e.target.closest("[data-rep-del]");
    if (del) { list.splice(Number(del.dataset.repDel), 1); draw(); }
  });
  draw();
  return { get rows() { return cleanRepeats(list); }, refresh: draw };
}
