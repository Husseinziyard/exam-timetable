// =====================================================================
// What each admin section looks like. To add a field, add one line here.
//   key      = column name in the database (and the CSV header)
//   type     = text | email | number | date | select | fk | multi | checkbox
//   list     = show as a column in the table
//   fk       = a dropdown that points to another table (see REFS below)
//   multi    = tick several items (stored in a link table)
//   auto     = checkbox filled in automatically from other fields
// =====================================================================

export const GRADES = [
  ["PROF", "Professor"],
  ["SL1", "Senior Lecturer Gr. I"],
  ["SL2", "Senior Lecturer Gr. II"],
  ["LECT", "Lecturer"],
  ["INSTR", "Instructor / Demonstrator"],
  ["MIL", "Military invigilator"],
  ["HA", "Hall attendant"],
  ["REG", "Registrar office (admin only, no duties)"],
];
const SUPERVISE_GRADES = ["PROF", "SL1", "SL2"];
const INVIGILATE_GRADES = ["LECT", "INSTR", "MIL"];

// Tables that other tables point to (used for dropdowns and CSV matching)
export const REFS = {
  departments: {
    table: "departments", select: "id,name", order: "name",
    label: (r) => r.name,
  },
  batches: {
    table: "batches", select: "id,intake,degree,stream", order: "intake",
    label: (r) => `Intake ${r.intake} · ${r.stream || r.degree}`,
    csvKeys: (r) => [`${r.intake}|${r.stream}`, `${r.intake}|${r.degree}`],   // CSV can say: 43|MTS
  },
  lecturers: {
    table: "lecturers", select: "id,title,full_name,email", order: "full_name",
    label: (r) => `${r.title ? r.title + " " : ""}${r.full_name}`,
    csvKeys: (r) => [r.email, r.full_name],                                  // CSV can use email or full name
  },
};

export const SECTIONS = {
  lecturers: {
    title: "Staff", singular: "staff member", table: "lecturers", pk: "id", order: "full_name", conflict: "full_name", hold: true,
    help: "Everyone who can get an exam duty: supervisors, invigilators (including staff from other faculties and military invigilators) and hall attendants. “Can supervise / can invigilate” are filled in from the grade; you can change them per person. Registrar office staff are admins only: they never get duties or availability forms.",
    fields: [
      { key: "title", label: "Title", list: true },
      { key: "full_name", label: "Full name", required: true, list: true },
      { key: "grade", label: "Grade", type: "select", options: GRADES, required: true, list: true },
      { key: "faculty", label: "Faculty", type: "select", list: true,
        options: [["FMSH", "FMSH"], ["FOE", "FOE"], ["FOC", "FOC"], ["FOL", "FOL"], ["FOM", "FOM"], ["FAHS", "FAHS"], ["FOT", "FOT"], ["Other", "Other"]] },
      { key: "department_id", label: "Department", type: "fk", ref: "departments", csv: "department" },
      { key: "email", label: "Email (needed to log in)", type: "email", list: true, lower: true },
      { key: "staff_no", label: "Staff / EPF number" },
      { key: "can_supervise", label: "Can supervise", type: "checkbox", list: true, auto: (r) => SUPERVISE_GRADES.includes(r.grade) },
      { key: "can_invigilate", label: "Can invigilate", type: "checkbox", list: true, auto: (r) => INVIGILATE_GRADES.includes(r.grade) },
      { key: "is_admin", label: "Admin access", type: "checkbox", filter: false, auto: (r) => r.grade === "REG" },
    ],
    example: { title: "Dr.", full_name: "AB Perera", grade: "SL1", faculty: "FMSH", department: "", email: "", staff_no: "1234", can_supervise: "", can_invigilate: "", is_admin: "false" },
  },

  rooms: {
    title: "Classes", singular: "class", table: "rooms", pk: "id", order: "name", conflict: "name", hold: true,
    help: "Exam halls and classrooms. The exam capacity is lower than the lecture capacity because of spacing between seats.",
    fields: [
      { key: "name", label: "Hall name", required: true, list: true },
      { key: "building", label: "Building / location", list: true, filter: true },
      { key: "lecture_capacity", label: "Lecture capacity", type: "number", list: true },
      { key: "exam_capacity", label: "Exam capacity", type: "number", required: true, list: true },
      { key: "seat_rows", label: "Seat rows (exam layout)", type: "number" },
      { key: "seats_per_row", label: "Seats per row (exam layout)", type: "number" },
      { key: "door_position", label: "Door position", type: "select", filter: false,
        options: [["front-left", "Front left"], ["front-right", "Front right"], ["back-left", "Back left"], ["back-right", "Back right"]] },
    ],
    example: { name: "6-1", building: "FMSH", lecture_capacity: "", exam_capacity: "58", seat_rows: "", seats_per_row: "", door_position: "front-left" },
  },

  modules: {
    title: "Modules", singular: "module", table: "modules", pk: "id", order: "code", conflict: "code", hold: true,
    help: "The full list of papers for every programme and semester. Add them once — each exam period you only choose which semester each intake is sitting. Tick every stream (programme) that sits a paper together, e.g. Business Law for MTS, MTH, LM and LMH. Papers with the same slot group (e.g. “Sinhala or Tamil”) are scheduled at the same time.",
    fields: [
      { key: "code", label: "Module code", required: true, list: true },
      { key: "name", label: "Module name", required: true, list: true },
      { key: "streams", label: "Streams sitting this paper", type: "tags", required: true, list: true,
        suggest: { table: "batches", column: "stream" },
        hint: "Stream codes as used in Batches (MTS, LM, BSM…). Not tied to an intake — every intake in this semester sits it." },
      { key: "semester", label: "Semester", type: "number", required: true, list: true, filter: true },
      { key: "duration_hours", label: "Paper length (hours)", type: "number", step: "0.5", list: true, filter: true },
      { key: "repeat_students", label: "Repeat students (R)", type: "number", list: true },
      { key: "expected_students", label: "Proper students override (empty = whole stream)", type: "number" },
      { key: "audience", label: "Who sits it", type: "select",
        options: [["all", "Everyone in the stream"], ["cadets", "Officer cadets only"], ["day_scholars", "Day scholars only"]] },
      { key: "slot_group", label: "Slot group (electives)", filter: true },
      { key: "examiner_id", label: "Examiner", type: "fk", ref: "lecturers", csv: "examiner", filter: false },
    ],
    example: { code: "MGT 110202", name: "Business Law", streams: "MTS; MTH; LM; LMH", semester: "1", duration_hours: "2", repeat_students: "15", expected_students: "", audience: "all", slot_group: "", examiner: "" },
  },

  batches: {
    title: "Batches", singular: "batch", table: "batches", pk: "id", order: "intake", conflict: "department_id,intake,degree", hold: true,
    help: "One batch = one stream of one intake, e.g. Intake 43 · MTS. Student count is the number of proper students (P).",
    fields: [
      { key: "intake", label: "Intake", type: "number", required: true, list: true, filter: true },
      { key: "stream", label: "Stream code (MTS, LM, BBA…)", required: true, list: true, filter: true },
      { key: "degree", label: "Degree programme", required: true, list: true },
      { key: "department_id", label: "Department", type: "fk", ref: "departments", required: true, list: true, csv: "department" },
      { key: "semester", label: "Current semester", type: "number", required: true, list: true, filter: true },
      { key: "student_count", label: "Proper students (P)", type: "number", list: true },
    ],
    example: { intake: "43", stream: "MTS", degree: "BSc in MTS", department: "Department of Management", semester: "2", student_count: "42" },
  },



  holidays: {
    title: "Calendar", singular: "holiday", table: "holidays", pk: "holiday_date", pkEditable: true, order: "holiday_date", conflict: "holiday_date", hold: false,
    help: "Public, Poya and university holidays. No exams are scheduled on these days, or on weekends.",
    fields: [
      { key: "holiday_date", label: "Date", type: "date", required: true, list: true },
      { key: "name", label: "Holiday", required: true, list: true },
    ],
    example: { holiday_date: "2026-12-25", name: "Christmas Day" },
  },

  departments: {
    title: "Departments", singular: "department", table: "departments", pk: "id", order: "name", conflict: "name", hold: true,
    help: "Tick “one exam per day” for departments where a batch may sit only one exam on any day.",
    fields: [
      { key: "name", label: "Department name", required: true, list: true },
      { key: "one_exam_per_day", label: "One exam per day", type: "checkbox", list: true },
    ],
    example: { name: "Department of Languages", one_exam_per_day: "true" },
  },
};

// Order of items in the sidebar
export const NAV = ["lecturers", "rooms", "modules", "batches", "holidays", "departments"];

// Sidebar icons (Tabler icon names)
export const ICONS = {
  overview: "ti-layout-dashboard", lecturers: "ti-users", rooms: "ti-door", modules: "ti-book",
  batches: "ti-school", holidays: "ti-calendar", departments: "ti-building",
};
