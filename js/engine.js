// =====================================================================
// TIMETABLE ENGINE — pure functions, no database code.
//   1. schedule()  : places every paper on a date + session
//   2. allocate()  : puts each paper's students into halls
//   3. staff()     : gives each hall 1 supervisor, 1–2 invigilators, 1 hall attendant
//   4. validate()  : the health check (also used after manual changes)
// =====================================================================

export const SESSIONS = ["AM", "PM"];
export const SESSION_START = { AM: 9, PM: 13 };

// How "heavy" one duty is per grade: higher = gets fewer duties
export const GRADE_WEIGHT = { PROF: 3, SL1: 2, SL2: 1.5, LECT: 1, INSTR: 1, MIL: 1, HA: 1 };

// ---------- small helpers ----------
export function seededRandom(seed = 1) {               // same seed -> same timetable
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const toDate = (s) => new Date(s + "T00:00:00Z");
const iso = (d) => d.toISOString().slice(0, 10);
export const dayDiff = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);

// Weekdays between start and end, skipping holidays
export function workingDays(start, end, holidays = []) {
  const skip = new Set(holidays);
  const out = [];
  for (let d = toDate(start); d <= toDate(end); d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !skip.has(iso(d))) out.push(iso(d));
  }
  return out;
}

export function timeLabel(session, hours = 3) {
  const s = SESSION_START[session];
  const end = s + Number(hours || 3);
  const f = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;
  return `${f(s)}–${f(end)}`;
}

// =====================================================================
// INPUT SHAPE (built by generate.js from the database)
//   units:   [{ key, modules:[{id, code, students}], batchIds:[..], students }]
//            one unit = papers that must sit at the same time (electives share a unit)
//   batches: { id: { intake, stream, onePerDay } }
//   rooms:   [{ id, name, cap }]
//   staff:   [{ id, name, grade, canSup, canInv, isHA, leave:[[from,to],...] }]
//   opts:    { days, threshold, minGap, seed }
// =====================================================================

// ---------- 1. DATES ----------
export function schedule(units, batches, rooms, opts) {
  const rand = seededRandom(opts.seed);
  const slots = opts.days.flatMap((d, di) => SESSIONS.map((s) => ({ date: d, session: s, di })));
  const totalCap = rooms.reduce((a, r) => a + r.cap, 0);
  const load = new Array(slots.length).fill(0);           // students per slot
  const place = new Map();                                 // unit.key -> slot index
  const byBatch = {};                                      // batchId -> Set(slot index)
  const intakeDays = {};                                   // day index -> Set(intakes)
  const warnings = [];
  for (const id in batches) byBatch[id] = new Set();

  const examsOf = (bid) => units.filter((u) => u.batchIds.includes(Number(bid))).length;

  // --- Step A: give each intake its own exam days (as the faculty does: Intake 42 one day, 43 the next) ---
  // An intake needs as many days as its busiest stream has papers (one paper per stream per day).
  const intakeOf = (u) => batches[u.batchIds[0]].intake;
  const need = {};
  for (const bid in batches) {
    const i = batches[bid].intake;
    need[i] = Math.max(need[i] || 0, examsOf(bid));
  }
  const intakes = Object.keys(need).filter((i) => need[i] > 0).sort((a, b) => need[b] - need[a]);
  const D = opts.days.length;
  const total = intakes.reduce((a, i) => a + need[i], 0);
  const ownDays = {};                                       // intake -> Set(day index)
  const taken = new Set();
  for (const i of intakes) {
    // spare days are shared out so every intake also gets study days in between
    const k = total <= D ? Math.min(D, need[i] + Math.floor((D - total) * need[i] / total)) : need[i];
    ownDays[i] = new Set();
    for (let j = 0; j < k; j++) {
      const ideal = Math.round(((j + 0.5) * D) / k - 0.5);
      // nearest day not yet given to another intake (if the period is too short, days are shared)
      let pick = -1;
      for (let off = 0; off < D && pick < 0; off++) {
        for (const c of [ideal + off, ideal - off]) {
          if (c >= 0 && c < D && !ownDays[i].has(c) && (total > D || !taken.has(c))) { pick = c; break; }
        }
      }
      if (pick >= 0) { ownDays[i].add(pick); taken.add(pick); }
    }
  }
  const order = [...units].sort((a, b) =>
    Math.max(...b.batchIds.map(examsOf)) - Math.max(...a.batchIds.map(examsOf)) || b.students - a.students);

  function cost(u, si, relaxed) {
    const slot = slots[si];
    if (load[si] + u.students > totalCap) return Infinity;           // not enough seats in all halls
    let c = 0;
    for (const bid of u.batchIds) {
      const b = batches[bid];
      for (const other of byBatch[bid]) {
        if (other === si) return Infinity;                          // same stream, same session
        const gap = Math.abs(slots[other].di - slot.di);
        if (gap === 0) {
          if (b.onePerDay || !relaxed) return Infinity;             // one exam per day
          c += 1000;
        } else if (gap <= opts.minGap) c += 300 * (opts.minGap + 1 - gap);   // too close: no study day
        else c -= Math.min(gap, 4) * 15;                            // reward spacing
      }
    }
    if (!ownDays[intakeOf(u)]?.has(slot.di)) c += relaxed ? 500 : Infinity;   // stay on this intake's own days
    const others = intakeDays[slot.di] || new Set();
    const mine = new Set(u.batchIds.map((b) => batches[b].intake));
    for (const i of others) if (!mine.has(i)) c += 60;             // avoid mixing intakes on one day
    c += ((load[si] + u.students) / totalCap) * 30;               // spread the load across sessions
    c += slot.session === "PM" ? 2 : 0;                            // tiny preference for mornings
    return c + rand() * 0.5;
  }

  function put(u, si) {
    place.set(u.key, si);
    load[si] += u.students;
    u.batchIds.forEach((b) => byBatch[b].add(si));
    (intakeDays[slots[si].di] ||= new Set());
    u.batchIds.forEach((b) => intakeDays[slots[si].di].add(batches[b].intake));
  }
  function remove(u) {
    const si = place.get(u.key);
    if (si === undefined) return;
    place.delete(u.key);
    load[si] -= u.students;
    u.batchIds.forEach((b) => byBatch[b].delete(si));
    // rebuild intakes for that day
    const di = slots[si].di;
    intakeDays[di] = new Set();
    for (const v of units) {
      const s = place.get(v.key);
      if (s !== undefined && slots[s].di === di) v.batchIds.forEach((b) => intakeDays[di].add(batches[b].intake));
    }
  }
  function best(u) {
    for (const relaxed of [false, true]) {
      let bi = -1, bc = Infinity;
      for (let si = 0; si < slots.length; si++) {
        const c = cost(u, si, relaxed);
        if (c < bc) { bc = c; bi = si; }
      }
      if (bi >= 0) return bi;
    }
    return -1;
  }

  // locked papers keep their place
  for (const u of units) if (u.locked) {
    const si = slots.findIndex((s) => s.date === u.locked.date && s.session === u.locked.session);
    if (si >= 0) put(u, si);
  }
  // first pass: place the hardest papers first
  for (const u of order) {
    if (place.has(u.key)) continue;
    const si = best(u);
    if (si >= 0) put(u, si);
  }
  // improvement passes: take each paper out and put it back in the best place
  for (let pass = 0; pass < 4; pass++) {
    for (const u of order) {
      if (u.locked) continue;
      remove(u);
      const si = best(u);
      if (si >= 0) put(u, si);
    }
  }
  const missing = units.filter((u) => !place.has(u.key));
  if (missing.length) {
    const needDays = Object.values(need).reduce((a, b) => a + b, 0);
    warnings.push({ level: "error", text: `${missing.length} paper${missing.length > 1 ? "s" : ""} could not be placed. ` +
      `The period has ${D} exam days; with one paper per stream per day and intakes on alternate days, about ${needDays} are needed. ` +
      `Make the period longer, or include fewer intakes.` });
    missing.forEach((u) => warnings.push({ level: "error", text: `Not placed: ${u.modules.map((m) => m.code).join(" / ")}` }));
  }

  return { slots, place, warnings };
}

// ---------- 2. HALLS ----------
export function allocate(units, batches, rooms, sched) {
  const warnings = [];
  const halls = new Map();          // "date|session|roomId" -> { date, session, roomId, used, exams:[{moduleId, seats, intake}] }
  const bySlot = new Map();
  for (const u of units) {
    const si = sched.place.get(u.key);
    if (si === undefined) continue;
    (bySlot.get(si) || bySlot.set(si, []).get(si)).push(u);
  }
  for (const [si, list] of bySlot) {
    const { date, session } = sched.slots[si];
    const state = rooms.map((r) => ({ ...r, used: 0, intakes: new Set(), key: `${date}|${session}|${r.id}` }));
    const papers = list.flatMap((u) => u.modules.map((m) => ({ ...m, intake: batches[u.batchIds[0]].intake })))
      .sort((a, b) => b.students - a.students);
    const give = (room, m, n) => {
      room.used += n; room.intakes.add(m.intake);
      const h = halls.get(room.key) || { date, session, roomId: room.id, exams: [] };
      h.exams.push({ moduleId: m.id, seats: n });
      halls.set(room.key, h);
    };
    const SMALL = 12;   // groups this small may share a hall with another paper of the same intake
    for (const m of papers) {
      let left = m.students;
      while (left > 0) {
        const free = state.filter((r) => r.used === 0);
        const share = state.filter((r) => r.used > 0 && r.cap - r.used >= left && r.intakes.has(m.intake))
          .sort((a, b) => (a.cap - a.used) - (b.cap - b.used))[0];
        // a small group (e.g. repeat students) joins a hall already in use instead of opening a new one
        if (share && left <= SMALL) { give(share, m, left); break; }
        const fits = free.filter((r) => r.cap >= left).sort((a, b) => a.cap - b.cap)[0];
        if (fits) { give(fits, m, left); break; }
        if (share) { give(share, m, left); break; }
        // too big for one hall: use the pair of free halls that fits with the least empty seats
        let pair = null;
        for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
          const sum = free[i].cap + free[j].cap;
          if (sum >= left && (!pair || sum < pair[2])) pair = [free[i], free[j], sum];
        }
        if (pair) {
          const [a, b] = pair[0].cap >= pair[1].cap ? pair : [pair[1], pair[0]];
          const first = Math.min(a.cap, left - Math.min(b.cap, Math.floor(left / 2)));   // spread fairly evenly
          give(a, m, first); give(b, m, left - first);
          break;
        }
        const big = free.sort((a, b) => b.cap - a.cap)[0];
        if (big) { give(big, m, big.cap); left -= big.cap; continue; }
        const any = state.filter((r) => r.cap - r.used > 0).sort((a, b) => (b.cap - b.used) - (a.cap - a.used))[0];
        if (any) { const n = Math.min(left, any.cap - any.used); give(any, m, n); left -= n; continue; }
        warnings.push({ level: "error", text: `${date} ${session}: ${left} students of ${m.code} have no seat.` });
        break;
      }
    }
  }
  return { halls: [...halls.values()], warnings };
}

// ---------- 3. STAFF ----------
export function assignStaff(halls, staff, opts, locked = []) {
  const rand = seededRandom(opts.seed + 7);
  const warnings = [];
  const load = new Map(staff.map((s) => [s.id, 0]));
  const busy = new Map();            // "date|session" -> Set(staff ids)
  const daily = new Map();           // "date|id" -> count
  const onLeave = (s, date) => (s.leave || []).some(([a, b]) => date >= a && date <= b);
  const sorted = [...halls].sort((a, b) =>
    a.date.localeCompare(b.date) || a.session.localeCompare(b.session) || b.students - a.students);

  // keep locked duties first
  for (const d of locked) {
    const h = halls.find((x) => x.date === d.date && x.session === d.session && x.roomId === d.roomId);
    if (!h) continue;
    h.duties ||= [];
    h.duties.push({ staffId: d.staffId, role: d.role, locked: true });
    take(h, d.staffId);
  }
  function take(h, id) {
    const slot = `${h.date}|${h.session}`;
    (busy.get(slot) || busy.set(slot, new Set()).get(slot)).add(id);
    const s = staff.find((x) => x.id === id);
    load.set(id, (load.get(id) || 0) + (GRADE_WEIGHT[s?.grade] || 1));
    daily.set(`${h.date}|${id}`, (daily.get(`${h.date}|${id}`) || 0) + 1);
  }
  function pick(h, ok) {
    const slot = `${h.date}|${h.session}`;
    const taken = busy.get(slot) || new Set();
    let best = null, bc = Infinity;
    for (const s of staff) {
      if (!ok(s) || taken.has(s.id) || onLeave(s, h.date)) continue;
      const c = load.get(s.id) + (daily.get(`${h.date}|${s.id}`) || 0) * 3 + rand() * 0.3;
      if (c < bc) { bc = c; best = s; }
    }
    return best;
  }
  for (const h of sorted) {
    h.duties ||= [];
    const need = [
      ["SUPERVISOR", 1, (s) => s.canSup],
      ["INVIGILATOR", h.students > opts.threshold ? 2 : 1, (s) => s.canInv && !s.isHA],
      ["ATTENDANT", 1, (s) => s.isHA],
    ];
    for (const [role, n, ok] of need) {
      const have = h.duties.filter((d) => d.role === role).length;
      for (let i = have; i < n; i++) {
        const s = pick(h, ok);
        if (!s) { warnings.push({ level: "warn", text: `${h.date} ${h.session}, ${h.roomName}: no free ${role.toLowerCase()} available.` }); break; }
        h.duties.push({ staffId: s.id, role });
        take(h, s.id);
      }
    }
  }
  return { warnings };
}

// ---------- the whole thing ----------
export function generate(input) {
  const { units, batches, rooms, staff, opts } = input;
  const sched = schedule(units, batches, rooms, opts);
  const alloc = allocate(units, batches, rooms, sched);
  const roomName = Object.fromEntries(rooms.map((r) => [r.id, r.name]));
  alloc.halls.forEach((h) => {
    h.students = h.exams.reduce((a, e) => a + e.seats, 0);
    h.roomName = roomName[h.roomId];
  });
  const st = assignStaff(alloc.halls, staff, opts, input.lockedDuties || []);
  const exams = units.flatMap((u) => {
    const si = sched.place.get(u.key);
    if (si === undefined) return [];
    return u.modules.map((m) => ({ moduleId: m.id, date: sched.slots[si].date, session: sched.slots[si].session }));
  });
  return { exams, halls: alloc.halls, warnings: [...sched.warnings, ...alloc.warnings, ...st.warnings] };
}

// =====================================================================
// 4. HEALTH CHECK — works on the saved timetable (so it also checks manual edits)
//   t = { exams:[{id, moduleId, date, session}], halls:[{id, date, session, roomId, cap, roomName,
//          exams:[{examId, seats}], duties:[{staffId, role}]}],
//          moduleBatches: {moduleId:[batchIds]}, moduleStudents:{moduleId:n}, batches, staff, threshold }
// =====================================================================
export function validate(t) {
  const out = [];
  const add = (level, text, ref) => out.push({ level, text, ref });
  const staffById = Object.fromEntries(t.staff.map((s) => [s.id, s]));
  const examById = Object.fromEntries(t.exams.map((e) => [e.id, e]));

  // a stream never sits two papers at once / one-per-day departments
  const perBatchSlot = new Map(), perBatchDay = new Map();
  for (const e of t.exams) for (const b of t.moduleBatches[e.moduleId] || []) {
    const k = `${b}|${e.date}|${e.session}`;
    if (perBatchSlot.has(k)) add("error", `${t.batches[b]?.label}: two papers at the same time on ${e.date} ${e.session}.`, e.id);
    perBatchSlot.set(k, e);
    const kd = `${b}|${e.date}`;
    perBatchDay.set(kd, (perBatchDay.get(kd) || 0) + 1);
  }
  for (const [k, n] of perBatchDay) if (n > 1) {
    const [b, date] = k.split("|");
    add(t.batches[b]?.onePerDay ? "error" : "warn", `${t.batches[b]?.label}: ${n} exams on ${date}.`);
  }
  // no study day between exams
  const datesByBatch = {};
  for (const e of t.exams) for (const b of t.moduleBatches[e.moduleId] || []) (datesByBatch[b] ||= new Set()).add(e.date);
  let tight = 0;
  for (const b in datesByBatch) {
    const ds = [...datesByBatch[b]].sort();
    for (let i = 1; i < ds.length; i++) if (dayDiff(ds[i - 1], ds[i]) === 1) tight++;
  }
  if (tight) add("info", `${tight} time${tight > 1 ? "s" : ""} a stream has exams on two days in a row (no study day).`);

  // halls: capacity, seats for everyone, staff
  const seated = {};
  const slotStaff = new Map();
  for (const h of t.halls) {
    const n = h.exams.reduce((a, e) => a + e.seats, 0);
    if (n > h.cap) add("error", `${h.date} ${h.session}, ${h.roomName}: ${n} students but only ${h.cap} seats.`, h.id);
    h.exams.forEach((e) => { seated[e.examId] = (seated[e.examId] || 0) + e.seats; });
    const roles = (r) => h.duties.filter((d) => d.role === r).length;
    if (roles("SUPERVISOR") < 1) add("error", `${h.date} ${h.session}, ${h.roomName}: no supervisor.`, h.id);
    const needInv = n > t.threshold ? 2 : 1;
    if (roles("INVIGILATOR") < needInv) add("error", `${h.date} ${h.session}, ${h.roomName}: needs ${needInv} invigilator${needInv > 1 ? "s" : ""}, has ${roles("INVIGILATOR")}.`, h.id);
    if (roles("ATTENDANT") < 1) add("warn", `${h.date} ${h.session}, ${h.roomName}: no hall attendant.`, h.id);
    for (const d of h.duties) {
      const s = staffById[d.staffId];
      const k = `${h.date}|${h.session}|${d.staffId}`;
      if (slotStaff.has(k)) add("error", `${s?.name || "Someone"} is in two halls at once on ${h.date} ${h.session}.`, h.id);
      slotStaff.set(k, h);
      if (s && (s.leave || []).some(([a, b]) => h.date >= a && h.date <= b)) add("error", `${s.name} is on leave on ${h.date} but has a duty.`, h.id);
      if (s?.onHold) add("warn", `${s.name} is on hold but has a duty on ${h.date}.`, h.id);
      if (s && d.role === "SUPERVISOR" && !s.canSup) add("warn", `${s.name} supervises on ${h.date} but is not marked “can supervise”.`, h.id);
    }
  }
  for (const e of t.exams) {
    const need = t.moduleStudents[e.moduleId] || 0;
    const got = seated[e.id] || 0;
    if (got < need) add("error", `${t.moduleCode?.[e.moduleId] || "A paper"} on ${e.date}: ${need - got} students without a seat.`, e.id);
  }
  // fairness: grade order (Professors fewest … Lecturers most)
  const counts = {};
  for (const h of t.halls) for (const d of h.duties) counts[d.staffId] = (counts[d.staffId] || 0) + 1;
  return out.sort((a, b) => ["error", "warn", "info"].indexOf(a.level) - ["error", "warn", "info"].indexOf(b.level));
}
