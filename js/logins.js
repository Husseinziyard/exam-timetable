// =====================================================================
// ADMIN: Staff logins
// The admin creates a login for each staff member (their Staff email + a temporary
// password). At first login they must choose their own password. If someone forgets
// it, the admin gives them a new temporary one ("Reset password").
// Passwords are stored as one-way hashes by Supabase, so they can't be shown later —
// a temporary password is shown once, right after it is made.
// Talks to the Supabase function "admin-users" (and "send-mail" to email the details).
// =====================================================================
import { supabase } from "./config.js";
import { toast } from "./crud.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const norm = (e) => String(e || "").trim().toLowerCase();
const when = (t) => t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

async function call(fn, body) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let m = error.message;
    try { m = (await error.context?.json())?.error || m; } catch {}
    if (/Failed to send|not found|404/i.test(m)) m = `The “${fn}” function isn't set up in Supabase yet (Edge Functions → deploy “${fn}”).`;
    throw new Error(m);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function renderLogins(root) {
  root._pageAbort?.abort();
  root._pageAbort = new AbortController();
  const on = (type, fn) => root.addEventListener(type, fn, { signal: root._pageAbort.signal });

  root.innerHTML = `<h1 class="page-title">Staff logins</h1><p class="loading">Loading…</p>`;
  const [{ data: staff }, list] = await Promise.all([
    supabase.from("lecturers").select("id,title,full_name,grade,email,on_hold").order("full_name"),
    call("admin-users", { action: "list" }).catch((e) => ({ error: e.message })),
  ]);
  const users = Object.fromEntries((list.users || []).map((u) => [u.email, u]));
  let filter = "all", search = "";
  const people = (staff || []).map((s) => ({ ...s, email: norm(s.email), login: users[norm(s.email)] || null }));
  const canCreate = people.filter((p) => p.email && !p.login && !p.on_hold);

  function draw() {
    const shown = people.filter((p) =>
      (filter === "all" || (filter === "none" && !p.login) || (filter === "waiting" && p.login?.must_change) || (filter === "active" && p.login && !p.login.must_change)) &&
      (!search || `${p.title} ${p.full_name} ${p.email}`.toLowerCase().includes(search)));
    const count = (f) => people.filter((p) => (f === "none" ? !p.login : f === "waiting" ? p.login?.must_change : p.login && !p.login.must_change)).length;
    root.innerHTML = `
      <h1 class="page-title">Staff logins</h1>
      <p class="page-sub">Create a login for each staff member. They sign in with their email and a temporary password, then choose their own.
        If someone forgets their password, use <b>Reset password</b> to give them a new temporary one.</p>
      ${list.error ? `<p class="msg show error">${esc(list.error)}</p>` : ""}
      <div class="toolbar">
        <input type="search" placeholder="Search name or email" value="${esc(search)}" data-search style="max-width:260px">
        <div class="seg small">${[["all", `All (${people.length})`], ["none", `No login (${count("none")})`], ["waiting", `Not logged in yet (${count("waiting")})`], ["active", `Active (${count("active")})`]]
          .map(([k, l]) => `<button type="button" class="${filter === k ? "on" : ""}" data-filter="${k}">${l}</button>`).join("")}</div>
        <span class="spacer"></span>
        <button class="btn" data-create-all ${canCreate.length && !list.error ? "" : "disabled"}><i class="ti ti-user-plus"></i> Create logins for ${canCreate.length} staff</button>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Name</th><th>Grade</th><th>Email</th><th>Login</th><th></th></tr></thead>
        <tbody>${shown.map((p) => `<tr data-email="${esc(p.email)}">
          <td><b>${esc([p.title, p.full_name].filter(Boolean).join(" "))}</b>${p.on_hold ? ' <span class="badge hold">On hold</span>' : ""}</td>
          <td>${esc(p.grade || "")}</td>
          <td>${p.email ? esc(p.email) : '<span class="muted">no email — add it in Staff</span>'}</td>
          <td>${!p.login ? '<span class="badge hold">No login</span>'
            : p.login.must_change ? `<span class="badge draft">Not logged in yet</span>`
            : `<span class="badge active">Active</span> <span class="muted small">${p.login.last_sign_in_at ? `last login ${when(p.login.last_sign_in_at)}` : ""}</span>`}</td>
          <td class="actions">${!p.email || list.error ? "" : !p.login
            ? `<button class="link" data-act="create">Create login</button>`
            : `<button class="link" data-act="reset">Reset password</button><button class="link danger" data-act="remove">Remove login</button>`}</td>
        </tr>`).join("") || `<tr><td colspan="5" class="muted center">Nobody matches.</td></tr>`}</tbody></table></div>
      <p class="small muted" style="margin-top:12px"><i class="ti ti-lock"></i> For safety, passwords are stored scrambled (hashed) — nobody, including the admin, can see a password once it's set.
        A temporary password is shown only once, right after you create or reset it.</p>`;
  }

  // Show the new temporary passwords (once), with copy / download / email
  function resultsDialog(items, skipped = []) {
    const dlg = document.createElement("dialog");
    dlg.className = "form-dialog wide-dialog";
    dlg.innerHTML = `<form method="dialog">
        <h2>${items.length} login${items.length === 1 ? "" : "s"} ready</h2>
        <p class="msg show ok" style="margin-top:0"><b>Save or send these now.</b> The temporary passwords can't be shown again (you can always reset them).</p>
        ${items.length ? `<div class="rep-table"><table class="data compact"><thead><tr><th>Email</th><th>Temporary password</th></tr></thead>
          <tbody>${items.map((i) => `<tr><td>${esc(i.email)}</td><td><code class="pw">${esc(i.password)}</code></td></tr>`).join("")}</tbody></table></div>` : ""}
        ${skipped.length ? `<p class="small muted" style="margin-top:10px">Skipped: ${skipped.map((s) => `${esc(s.email)} (${esc(s.reason)})`).join(", ")}</p>` : ""}
        <div class="dialog-actions" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
          <span style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn light" data-copy ${items.length ? "" : "disabled"}><i class="ti ti-copy"></i> Copy</button>
            <button type="button" class="btn light" data-csv ${items.length ? "" : "disabled"}><i class="ti ti-download"></i> Download list</button>
            <button type="button" class="btn" data-mail ${items.length ? "" : "disabled"}><i class="ti ti-mail"></i> Email each person their login</button>
          </span>
          <button class="btn light" value="close">Done</button>
        </div></form>`;
    document.body.appendChild(dlg); dlg.showModal();
    dlg.addEventListener("close", () => { dlg.remove(); renderLogins(root); });
    const text = items.map((i) => `${i.email}\t${i.password}`).join("\n");
    dlg.querySelector("[data-copy]").onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { prompt("Copy:", text); }
    };
    dlg.querySelector("[data-csv]").onclick = () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([`email,temporary_password\n${items.map((i) => `${i.email},${i.password}`).join("\n")}`], { type: "text/csv" }));
      a.download = "staff-logins.csv"; a.click();
    };
    dlg.querySelector("[data-mail]").onclick = async (e) => {
      const b = e.currentTarget;
      if (!confirm(`Email ${items.length} staff their own login details (one email each, from the exam office Gmail)?`)) return;
      b.disabled = true; b.innerHTML = '<i class="ti ti-loader-2 spin"></i> Sending…';
      try {
        const r = await call("send-mail", { kind: "credentials", items, site: new URL(".", location.href).href });
        toast(r.failed?.length ? `Sent ${r.sent}; failed: ${r.failed.join(", ")}` : `Login details emailed to ${r.sent} staff.`, r.failed?.length ? "error" : "ok");
        b.innerHTML = '<i class="ti ti-check"></i> Emailed';
      } catch (err) { toast(`Not sent: ${err.message}`, "error"); b.disabled = false; b.innerHTML = '<i class="ti ti-mail"></i> Email each person their login'; }
    };
  }

  on("input", (e) => { if (e.target.matches("[data-search]")) { search = e.target.value.trim().toLowerCase(); draw(); root.querySelector("[data-search]").focus(); root.querySelector("[data-search]").setSelectionRange(search.length, search.length); } });
  on("click", async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) { filter = f.dataset.filter; return draw(); }
    if (e.target.closest("[data-create-all]")) {
      if (!confirm(`Create logins for ${canCreate.length} staff who have an email but no login yet?`)) return;
      try { const r = await call("admin-users", { action: "create", emails: canCreate.map((p) => p.email) }); resultsDialog(r.created, r.skipped); }
      catch (err) { toast(err.message, "error"); }
      return;
    }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const email = b.closest("tr").dataset.email, act = b.dataset.act;
    try {
      if (act === "create") { const r = await call("admin-users", { action: "create", emails: [email] }); return resultsDialog(r.created, r.skipped); }
      if (act === "reset") {
        if (!confirm(`Give ${email} a new temporary password? Their current password stops working.`)) return;
        const r = await call("admin-users", { action: "reset", email }); return resultsDialog([r]);
      }
      if (act === "remove") {
        if (!confirm(`Remove the login for ${email}? They won't be able to sign in until you create a new one. (Their staff record and duties stay.)`)) return;
        await call("admin-users", { action: "remove", email }); toast("Login removed."); return renderLogins(root);
      }
    } catch (err) { toast(err.message, "error"); }
  });
  draw();
}
