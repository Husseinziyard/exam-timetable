// =====================================================================
// What each admin section looks like. To add a field, add one line here.
//   key      = column name in the database (and the CSV header)
//   type     = text | email | number | date | select | fk | checkbox
//   list     = show as a column in the table
//   fk       = a dropdown that points to another table (see REFS below)
// =====================================================================

export const GRADES = [
  ["PROF", "Professor"],
  ["SL1", "Senior Lecturer Gr. I"],
  ["SL2", "Senior Lecturer Gr. II"],
  ["LECT", "Lecturer"],
];

// Tables that other tables point to (used for dropdowns and CSV matching)
export const REFS = {
  departments: {
    table: "departments", select: "id,name", order: "name",
    label: (r) => r.name,
  },
  batches: {
    table: "batches", select: "id,intake,degree", order: "intake",
    label: (r) => `Intake ${r.intake} · ${r.degree}`,
    csvKey: (r) => `${r.intake}|${r.degree}`,              // CSV can say: 41|BSc Applied Data Science
  },
  lecturers: {
    table: "lecturers", select: "id,title,full_name,email", order: "full_name",
    label: (r) => `${r.title ? r.title + " " : ""}${r.full_name}`,
    csvKey: (r) => r.email,                                 // CSV can use the lecturer's email
  },
};

export const SECTIONS = {
  lecturers: {
    title: "Lecturers", singular: "lecturer", table: "lecturers", pk: "id", order: "full_name", conflict: "email", hold: true,
    help: "Professors and Senior Lecturers Gr. I can supervise; everyone else invigilates. Put a lecturer on hold to leave them out of new timetables.",
    fields: [
      { key: "title", label: "Title", type: "select", list: true,
        options: [["Prof.", "Prof."], ["Dr.", "Dr."], ["Mr.", "Mr."], ["Ms.", "Ms."], ["Mrs.", "Mrs."]] },
      { key: "full_name", label: "Full name", required: true, list: true },
      { key: "grade", label: "Grade", type: "select", options: GRADES, required: true, list: true },
      { key: "department_id", label: "Department", type: "fk", ref: "departments", list: true, csv: "department" },
      { key: "email", label: "Email (used to log in)", type: "email", required: true, list: true, lower: true },
      { key: "staff_no", label: "Staff number" },
      { key: "is_admin", label: "Admin access", type: "checkbox" },
    ],
    example: { title: "Dr.", full_name: "A. B. Perera", grade: "SL1", department: "Department of Management", email: "perera@example.lk", staff_no: "S001", is_admin: "false" },
  },

  rooms: {
    title: "Classes", singular: "class", table: "rooms", pk: "id", order: "name", conflict: "name", hold: true,
    help: "Lecture halls and classrooms. The exam capacity is lower than the lecture capacity because of spacing between seats.",
    fields: [
      { key: "name", label: "Room name", required: true, list: true },
      { key: "building", label: "Building", list: true },
      { key: "lecture_capacity", label: "Lecture capacity", type: "number", list: true },
      { key: "exam_capacity", label: "Exam capacity", type: "number", required: true, list: true },
      { key: "seat_rows", label: "Seat rows (exam layout)", type: "number" },
      { key: "seats_per_row", label: "Seats per row (exam layout)", type: "number" },
      { key: "door_position", label: "Door position", type: "select",
        options: [["front-left", "Front left"], ["front-right", "Front right"], ["back-left", "Back left"], ["back-right", "Back right"]] },
    ],
    example: { name: "Hall B2", building: "Main", lecture_capacity: "70", exam_capacity: "45", seat_rows: "9", seats_per_row: "5", door_position: "front-left" },
  },

  modules: {
    title: "Modules", singular: "module", table: "modules", pk: "id", order: "code", conflict: "code", hold: true,
    help: "Each module belongs to one batch. Modules on hold are left out of new timetables.",
    fields: [
      { key: "code", label: "Module code", required: true, list: true },
      { key: "name", label: "Module name", required: true, list: true },
      { key: "batch_id", label: "Batch", type: "fk", ref: "batches", required: true, list: true, csv: "batch" },
      { key: "semester", label: "Semester", type: "number", required: true, list: true },
      { key: "duration_hours", label: "Exam duration (hours)", type: "number", step: "0.5" },
      { key: "examiner_id", label: "Examiner", type: "fk", ref: "lecturers", list: true, csv: "examiner_email" },
    ],
    example: { code: "DS3012", name: "Applied Data Science and AI", batch: "41|BSc Applied Data Science Communication", semester: "5", duration_hours: "3", examiner_email: "perera@example.lk" },
  },

  batches: {
    title: "Batches", singular: "batch", table: "batches", pk: "id", order: "intake", conflict: "department_id,intake,degree", hold: true,
    help: "One batch = one intake of one degree programme, e.g. Intake 41 · BSc Applied Data Science Communication.",
    fields: [
      { key: "department_id", label: "Department", type: "fk", ref: "departments", required: true, list: true, csv: "department" },
      { key: "intake", label: "Intake", type: "number", required: true, list: true },
      { key: "degree", label: "Degree programme", required: true, list: true },
      { key: "semester", label: "Current semester", type: "number", required: true, list: true },
    ],
    example: { department: "Department of Social Sciences", intake: "41", degree: "BSc Applied Data Science Communication", semester: "5" },
  },

  students: {
    title: "Students", singular: "student", table: "students", pk: "index_no", pkEditable: true, order: "index_no", conflict: "index_no", hold: true,
    help: "Students are seated by index number; repeat students sit at the back. Use sample data until the faculty approves real data.",
    fields: [
      { key: "index_no", label: "Index number", required: true, list: true },
      { key: "full_name", label: "Full name", required: true, list: true },
      { key: "batch_id", label: "Batch", type: "fk", ref: "batches", required: true, list: true, csv: "batch" },
      { key: "email", label: "Email (used to log in)", type: "email", list: true, lower: true },
    ],
    example: { index_no: "D/BSC/41/0001", full_name: "Sample Student", batch: "41|BSc Applied Data Science Communication", email: "student1@example.lk" },
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
export const NAV = ["lecturers", "rooms", "modules", "batches", "students", "holidays", "departments"];
