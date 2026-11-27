// Shared login helpers used by every page.
import { supabase } from "./config.js";

// Which page each role lands on after logging in
export const HOME = { admin: "admin.html", lecturer: "lecturer.html" };

// Which roles may enter through each door on the front page
export const ALLOWED = {
  admin: ["admin"],
  lecturer: ["lecturer", "admin"],   // an admin is also a lecturer
};

// Ask the database who this user is: 'admin' | 'lecturer' | 'none'
export async function getRole() {
  const { data, error } = await supabase.rpc("my_role");
  if (error) throw error;
  return data;
}

// Put this at the top of every protected page.
// Sends the visitor back to the login page if they are not allowed here.
export async function requireRole(door) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    location.replace(`login.html?role=${door}`);
    return null;
  }
  // a login made by the admin starts with a temporary password: choose your own first
  if (session.user.user_metadata?.must_change_password) {
    location.replace(`password.html?first=1&next=${encodeURIComponent(location.pathname.split("/").pop() || "index.html")}`);
    return null;
  }
  const role = await getRole();
  if (!ALLOWED[door]?.includes(role)) {
    await supabase.auth.signOut();
    location.replace(`login.html?role=${door}&denied=1`);
    return null;
  }
  watchSession(door);
  return { user: session.user, role };
}

// While a page is open, keep checking that the login is still valid. If the admin resets
// this person's password or removes their login, send them back to the login screen.
let watching = false;
function watchSession(door) {
  if (watching) return;
  watching = true;
  let busy = false;
  const check = async () => {
    if (busy || document.visibilityState === "hidden") return;
    busy = true;
    try {
      const { data, error } = await supabase.auth.getUser();     // asks the server, not the browser's copy
      let why = null;
      if (error && error.status >= 400 && error.status < 500) why = "ended";   // session revoked or login removed
      else if (!error && !data?.user) why = "ended";
      else if (data?.user?.user_metadata?.must_change_password) why = "reset";
      if (why) {
        await supabase.auth.signOut({ scope: "local" }).catch(() => {});
        location.replace(`login.html?role=${door}&ended=${why}`);
      }
    } catch { /* offline: try again later */ }
    busy = false;
  };
  setInterval(check, 30000);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
}

export async function signOut() {
  await supabase.auth.signOut();
  location.replace("index.html");
}

// Fills in the header name and wires up the "Log out" button
export function setupHeader(user) {
  const who = document.getElementById("who");
  if (who) who.textContent = user.email;
  const btn = document.getElementById("logout");
  if (btn) {
    btn.addEventListener("click", signOut);
    if (!document.getElementById("pw-link")) btn.insertAdjacentHTML("beforebegin",
      `<a id="pw-link" class="top-link" href="password.html?next=${encodeURIComponent(location.pathname.split("/").pop() || "index.html")}">Change password</a>`);
  }
}
