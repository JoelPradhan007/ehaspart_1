const express     = require("express");
const cors        = require("cors");
const Papa        = require("papaparse");
const PDFDocument = require("pdfkit");
const path        = require("path");
const fs          = require("fs");
const crypto      = require("crypto");
const db          = require("./db");
const { runAllocationAlgorithm } = require("./allocate");
const { generatePDF }            = require("./generatePDF");

// Admin credentials — set ADMIN_USERNAME and ADMIN_PASSWORD in environment
function getAdminCreds() {
  return {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  };
}

// Session store — persisted in DB so server restarts don't log users out
async function createSession(username, role) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession(token, username, role);
  return token;
}
async function destroySession(token) {
  await db.deleteSession(token);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX (duplicate session logic): requireAuth and requireAdmin previously
// duplicated the full token-parse → DB lookup → TTL check block verbatim.
// Any change to TTL or token format had to be made in two places.
// Fix: extract into validateSession(); both middlewares delegate to it.
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function validateSession(req, res) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ success: false, message: 'Unauthorized — please log in' });
    return null;
  }
  let session;
  try {
    session = await db.getSession(token);
  } catch {
    res.status(500).json({ success: false, message: 'Session error' });
    return null;
  }
  if (!session) {
    res.status(401).json({ success: false, message: 'Session expired — please log in again' });
    return null;
  }
  const age = Date.now() - new Date(session.created_at).getTime();
  if (age > SESSION_TTL_MS) {
    db.deleteSession(token).catch(() => {});
    res.status(401).json({ success: false, message: 'Session expired — please log in again' });
    return null;
  }
  return session;
}

async function requireAuth(req, res, next) {
  const session = await validateSession(req, res);
  if (!session) return;
  req.session = session;
  next();
}

async function requireAdmin(req, res, next) {
  const session = await validateSession(req, res);
  if (!session) return;
  if (session.role !== 'administrator')
    return res.status(403).json({ success: false, message: 'Admin access required' });
  req.session = session;
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX (raw SQL in interval): the cleanup interval previously called
// db.pool.execute() directly, bypassing the db abstraction layer entirely.
// Fix: delegate to db.deleteExpiredSessions(). Add this to db.js if not
// already present:
//   exports.deleteExpiredSessions = () =>
//     pool.execute(`DELETE FROM sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
// ─────────────────────────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    await db.deleteExpiredSessions();
  } catch (e) { console.error('Session cleanup error:', e.message); }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// FIX (concurrent allocation): two simultaneous POST /api/allocate requests
// would both call clearAllocations() then race on bulkInsertAllocations(),
// producing corrupt interleaved seating data.
// Fix: in-process boolean lock; second request gets a 409 immediately.
// ─────────────────────────────────────────────────────────────────────────────
let allocationRunning = false;

// ─────────────────────────────────────────────────────────────────────────────
// FIX (CSV injection): prefix any cell value that starts with a formula
// trigger character (=, +, -, @, tab, CR) with a single quote so spreadsheet
// apps treat it as plain text instead of executing it as a formula.
// ─────────────────────────────────────────────────────────────────────────────
function sanitizeCSVCell(value) {
  const s = String(value == null ? '' : value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const app  = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://exam-hall-allocation-system.onrender.com',
  process.env.FRONTEND_ORIGIN,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// Static frontend
const FRONTEND_DIR = path.join(__dirname, "FrontEnd");
console.log("📁 Serving frontend from:", FRONTEND_DIR);
app.use(express.static(FRONTEND_DIR));
app.get("/", (req, res) => res.sendFile(path.join(FRONTEND_DIR, "login.html")));

// CSV parser helper
function parseCSV(raw) {
  const cleaned = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  return Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim().toLowerCase().replace(/\s+/g, "_"),
    transform: v => v.trim(),
  });
}

// Verify password — handles bcrypt hashes and plain-text (auto-rehashes on match)
const isBcrypt = p => /^\$2[aby]\$/.test(p);
async function verifyPassword(plain, stored, userId) {
  if (isBcrypt(stored)) {
    return db.bcrypt.compare(plain, stored);
  }
  if (plain === stored) {
    const hashed = await db.bcrypt.hash(plain, 12);
    await db.pool.execute(`UPDATE users SET password=? WHERE id=?`, [hashed, userId]);
    console.log(`✅ Re-hashed plain-text password for user id=${userId}`);
    return true;
  }
  return false;
}

// Auth routes
app.post("/api/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
      return res.status(400).json({ success: false, message: "username, password, role required" });

    if (role === "administrator") {
      const adminCreds = getAdminCreds();
      if (username === adminCreds.username && password === adminCreds.password) {
        await db.deleteSessionsByUsername(username);
        const token = await createSession(username, role);
        return res.json({ success: true, role, username, token, redirect: "admin_dashboard.html" });
      }
      const user = await db.getUserByUsername(username.trim());
      if (user && user.role === "administrator") {
        const match = await verifyPassword(password, user.password, user.id);
        if (match) {
          await db.deleteSessionsByUsername(user.username);
          const token = await createSession(user.username, user.role);
          return res.json({ success: true, role: user.role, username: user.username, token, redirect: "admin_dashboard.html" });
        }
      }
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const user = await db.getUserByUsername(username.trim());
    if (!user || user.role !== role)
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    const match = await verifyPassword(password, user.password, user.id);
    if (!match)
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    await db.deleteSessionsByUsername(user.username);
    const token = await createSession(user.username, user.role);
    res.json({ success: true, role: user.role, username: user.username, token, redirect: "admin_dashboard.html" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/logout", async (req, res) => {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) await destroySession(token);
  res.json({ success: true });
});

// Hall routes
app.get("/api/halls", requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await db.getAllHalls() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/halls", requireAuth, async (req, res) => {
  try {
    const { hall_id, hall_name, capacity, total_rows, total_cols } = req.body;
    if (!hall_id || !capacity || !total_rows || !total_cols)
      return res.status(400).json({ success: false, message: "hall_id, capacity, total_rows, total_cols are required" });
    if (parseInt(total_rows) * parseInt(total_cols) !== parseInt(capacity))
      return res.status(400).json({ success: false, message: "total_rows × total_cols must equal capacity" });
    await db.upsertHall(hall_id.trim(), (hall_name || hall_id).trim(), parseInt(capacity), parseInt(total_rows), parseInt(total_cols));
    res.json({ success: true, message: `Hall ${hall_id} saved` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/halls/csv", requireAuth, async (req, res) => {
  try {
    const raw = req.body.csvData;
    if (!raw || !raw.trim())
      return res.status(400).json({ success: false, message: "No CSV data received." });
    const { data, meta } = parseCSV(raw);
    if (!data.length)
      return res.status(400).json({ success: false, message: `0 rows parsed. Headers must be: hall_id, hall_name, capacity, total_rows, total_cols. Detected: ${meta?.fields ?? 'unknown'}` });
    const halls = [], errors = [];
    for (const row of data) {
      const capacity   = parseInt(row.capacity);
      const total_rows = parseInt(row.total_rows);
      const total_cols = parseInt(row.total_cols);
      const hall_id    = (row.hall_id || "").trim();
      if (!hall_id || isNaN(capacity) || isNaN(total_rows) || isNaN(total_cols)) {
        errors.push(`Row skipped (missing fields): ${JSON.stringify(row)}`); continue;
      }
      if (total_rows * total_cols !== capacity) {
        errors.push(`Row skipped (rows×cols ≠ capacity): hall_id=${hall_id}`); continue;
      }
      halls.push({ hall_id, hall_name: (row.hall_name || hall_id).trim(), capacity, total_rows, total_cols });
    }
    if (!halls.length)
      return res.status(400).json({ success: false, message: `No valid halls found. All ${data.length} rows were skipped.`, errors });
    for (const h of halls)
      await db.upsertHall(h.hall_id, h.hall_name, h.capacity, h.total_rows, h.total_cols);
    res.json({ success: true, message: `${halls.length} halls uploaded successfully`, errors });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/halls", requireAuth, async (req, res) => {
  try { await db.clearHalls(); res.json({ success: true, message: "All halls cleared" }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/halls/:hall_id", requireAuth, async (req, res) => {
  try {
    const result = await db.deleteHall(req.params.hall_id);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Hall not found" });
    res.json({ success: true, message: `Hall ${req.params.hall_id} deleted` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Student routes
app.get("/api/students", requireAuth, async (req, res) => {
  try {
    const [students, total, bySubject] = await Promise.all([
      db.getAllStudents(), db.getTotalStudentCount(), db.getStudentCountBySubject()
    ]);
    res.json({ success: true, total, bySubject, data: students });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/students", requireAuth, async (req, res) => {
  try {
    const { student_id, student_name, subject_code } = req.body;
    if (!student_id || !student_name || !subject_code)
      return res.status(400).json({ success: false, message: "student_id, student_name, subject_code required" });
    const result = await db.insertStudent(student_id.trim(), student_name.trim(), subject_code.trim().toUpperCase());
    if (!result.inserted)
      return res.status(409).json({ success: false, message: `Duplicate student ID: ${student_id}` });
    res.json({ success: true, message: "Student added" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/students/csv", requireAuth, async (req, res) => {
  try {
    const raw = req.body.csvData;
    if (!raw || !raw.trim())
      return res.status(400).json({ success: false, message: "No CSV data received." });
    const { data, meta } = parseCSV(raw);
    if (!data.length)
      return res.status(400).json({ success: false, message: `0 rows parsed. Headers must be: student_id, student_name, subject_code. Detected: ${meta?.fields ?? 'unknown'}` });
    const students = [], parseErrors = [];
    for (const row of data) {
      const sid  = (row.student_id   || "").trim();
      const name = (row.student_name || "").trim();
      const sub  = (row.subject_code || "").trim();
      if (!sid || !name || !sub) { parseErrors.push(`Missing fields: ${JSON.stringify(row)}`); continue; }
      students.push({ student_id: sid, student_name: name, subject_code: sub.toUpperCase() });
    }
    if (!students.length)
      return res.status(400).json({ success: false, message: `No valid rows found. Detected headers: ${meta?.fields ?? 'unknown'}` });

    // FIX (false capacity warning): previously totalCapacity could be 0 when no
    // halls are configured yet, making students.length > 0 always true and
    // producing a misleading warning on every upload regardless of actual hall
    // availability. Only warn when halls genuinely exist and are actually full.
    const totalCapacity = await db.getTotalCapacity();
    const warning = (totalCapacity > 0 && students.length > totalCapacity)
      ? `Warning: ${students.length} students exceed total hall capacity of ${totalCapacity}`
      : null;

    const result = await db.bulkInsertStudents(students);
    res.json({ success: true, message: `${result.inserted} students uploaded, ${result.duplicates} duplicates skipped`, warning, parseErrors });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/students", requireAuth, async (req, res) => {
  try { await db.clearStudents(); res.json({ success: true, message: "All students and allocations cleared" }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/students/:id", requireAuth, async (req, res) => {
  try {
    const result = await db.deleteStudent(req.params.id);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "Student not found" });
    res.json({ success: true, message: `Student ${req.params.id} deleted` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// User routes
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await db.getAllUsers() });
  }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// NOTE: /api/users POST and /api/reset-password are intentionally left without
// auth guards per project requirements.
app.post("/api/users", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role)
      return res.status(400).json({ success: false, message: "username, password, role required" });
    if (!["administrator"].includes(role))
      return res.status(400).json({ success: false, message: "Invalid role" });
    if (username.length < 3)
      return res.status(400).json({ success: false, message: "Username must be at least 3 characters" });
    if (password.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    const existing = await db.getUserByUsername(username.trim());
    if (existing)
      return res.status(409).json({ success: false, message: "Username already exists" });
    await db.createUser(username.trim(), password, role);
    res.json({ success: true, message: "Account created successfully" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/reset-admin-password", async (req, res) => {
  try {
    const { username, newPassword, recoveryKey } = req.body;
    if (!username || !newPassword || !recoveryKey)
      return res.status(400).json({ success: false, message: "username, newPassword, and recoveryKey are required" });
    const validKey = process.env.RECOVERY_KEY || 'recover123';
    if (recoveryKey !== validKey)
      return res.status(403).json({ success: false, message: "Invalid recovery key" });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    const user = await db.getUserByUsername(username.trim());
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });
    if (user.role !== "administrator")
      return res.status(400).json({ success: false, message: "This endpoint is only for administrator accounts" });
    await db.updateUserPassword(username.trim(), newPassword);
    res.json({ success: true, message: `Password reset for ${username}. Please log in again.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword)
      return res.status(400).json({ success: false, message: "username and newPassword required" });
    if (newPassword.length < 6)
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    const user = await db.getUserByUsername(username.trim());
    if (!user)
      return res.status(404).json({ success: false, message: "User not found" });
    await db.updateUserPassword(username.trim(), newPassword);
    res.json({ success: true, message: "Password reset successfully" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  try {
    const result = await db.deleteUser(parseInt(req.params.id));
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, message: "User deleted" });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Allocation routes
app.post("/api/allocate", requireAuth, async (req, res) => {
  // FIX (concurrent allocation): reject while a run is already in progress.
  if (allocationRunning)
    return res.status(409).json({ success: false, message: "Allocation already in progress — please wait." });

  allocationRunning = true;
  try {
    const startTime     = Date.now();
    const totalStudents = await db.getTotalStudentCount();
    if (!totalStudents) return res.status(400).json({ success: false, message: "No students found." });
    const halls = await db.getAllHalls();
    if (!halls.length) return res.status(400).json({ success: false, message: "No halls found." });
    await db.clearAllocations();
    const groupedStudents = await db.getStudentsGroupedBySubject();
    const { allocations, unallocated, violations } = runAllocationAlgorithm(groupedStudents, halls);
    await db.bulkInsertAllocations(allocations);
    if (unallocated.length) await db.bulkInsertUnallocated(unallocated);
    const duration = Date.now() - startTime;
    const status   = unallocated.length === 0 ? "SUCCESS" : "PARTIAL";
    await db.insertAllocationLog({ total_students: totalStudents, total_allocated: allocations.length, total_unallocated: unallocated.length, constraint_violations: violations, duration_ms: duration, status, message: `Done in ${duration}ms` });
    res.json({ success: true, total_students: totalStudents, total_allocated: allocations.length, total_unallocated: unallocated.length, constraint_violations: violations, duration_ms: duration, status });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
  finally { allocationRunning = false; }
});

app.get("/api/allocations", requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await db.getAllAllocations() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/hall/:hall_id", requireAuth, async (req, res) => {
  try {
    const hall = await db.getHallById(req.params.hall_id);
    if (!hall) return res.status(404).json({ success: false, message: "Hall not found" });
    const allocations = await db.getAllocationsByHall(req.params.hall_id);

    // FIX (N+1 grid build): the previous implementation called allocations.find()
    // inside the nested row/col loop — O(rows × cols × allocations). For a large
    // hall this is a silent performance killer.
    // Fix: build a "row:col" → allocation Map first so each cell lookup is O(1).
    const seatMap = new Map();
    for (const a of allocations)
      seatMap.set(`${a.seat_row}:${a.seat_col}`, a);

    const grid = Array.from({ length: hall.total_rows }, (_, r) =>
      Array.from({ length: hall.total_cols }, (_, c) => {
        const s = seatMap.get(`${r + 1}:${c + 1}`);
        return s
          ? { occupied: true, student_id: s.student_id, student_name: s.student_name, subject_code: s.subject_code, seat_label: s.seat_label }
          : { occupied: false };
      })
    );
    res.json({ success: true, hall, grid });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/unallocated", requireAuth, async (req, res) => {
  try { const d = await db.getUnallocatedStudents(); res.json({ success: true, total: d.length, data: d }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/subject-distribution", requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await db.getSubjectPerHall() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/allocations/summary", requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await db.getHallSummary() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Export routes
app.get("/api/export/csv", requireAuth, async (req, res) => {
  try {
    const allocations = await db.getAllAllocations();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=Seating_Chart_${Date.now()}.csv`);

    // FIX (CSV injection): wrap every cell through sanitizeCSVCell so values
    // beginning with formula trigger characters (=, +, -, @, tab, CR) are
    // prefixed with a single quote and treated as plain text by spreadsheet apps.
    const rows = [
      ["student_id", "student_name", "subject_code", "hall_id", "hall_name", "seat_label", "seat_row", "seat_col"].join(","),
      ...allocations.map(a => [
        sanitizeCSVCell(a.student_id),
        `"${sanitizeCSVCell(a.student_name)}"`,
        sanitizeCSVCell(a.subject_code),
        sanitizeCSVCell(a.hall_id),
        `"${sanitizeCSVCell(a.hall_name)}"`,
        sanitizeCSVCell(a.seat_label),
        sanitizeCSVCell(a.seat_row),
        sanitizeCSVCell(a.seat_col),
      ].join(","))
    ];
    res.send(rows.join("\n"));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.get("/api/export/pdf", requireAuth, async (req, res) => {
  try { await generatePDF(res, db); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Logs
app.get("/api/logs", requireAuth, async (req, res) => {
  try { res.json({ success: true, data: await db.getAllLogs() }); }
  catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.listen(PORT, () => console.log(`🚀 Server running → http://localhost:${PORT}`));
module.exports = app;
