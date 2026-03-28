// ============================================
// db.js - Database Layer
// ============================================

const mysql  = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const SALT_ROUNDS = 12;

const pool = mysql.createPool({
  host:             process.env.DB_HOST     || "localhost",
  user:             process.env.DB_USER     || "root",
  password:         process.env.DB_PASSWORD || "joel",
  database:         process.env.DB_NAME     || "exam_seating1",
  port:             parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit:  10,
  queueLimit:       0,
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
});

pool.getConnection()
  .then(async conn => {
    console.log("✅ MySQL connected");

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        token      VARCHAR(64)  PRIMARY KEY,
        username   VARCHAR(100) NOT NULL,
        role       VARCHAR(50)  NOT NULL,
        created_at TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [cols] = await conn.execute(`SHOW COLUMNS FROM users WHERE Field='role'`);
    const enumVal = cols[0]?.Type || '';
    if (!enumVal.includes('administrator')) {
      await conn.execute(`
        ALTER TABLE users MODIFY COLUMN role ENUM('administrator') NOT NULL
      `);
      console.log("✅ users.role ENUM updated");
    }
    console.log("✅ Tables verified");

    const [users] = await conn.execute(
      `SELECT id, password FROM users WHERE password NOT LIKE '$2%'`
    );
    if (users.length > 0) {
      for (const u of users) {
        if (/^\$2[aby]\$/.test(u.password)) {
          console.log(`⚠️  Skipping already-hashed password for user id=${u.id}`);
          continue;
        }
        const hashed = await bcrypt.hash(u.password, SALT_ROUNDS);
        await conn.execute(`UPDATE users SET password=? WHERE id=?`, [hashed, u.id]);
      }
      console.log(`✅ Migrated ${users.length} plain-text password(s) to bcrypt`);
    }

    conn.release();
  })
  .catch(err => {
    console.error("❌ MySQL connection failed:", err.message);
    console.error("⚠️  Check DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT env vars.");
    // Do NOT call process.exit(1) — let the server stay up so Render doesn't crash-loop.
  });

// ============================================
// HALLS
// ============================================
const upsertHall = async (hall_id, hall_name, capacity, total_rows, total_cols) => {
  const [r] = await pool.execute(
    `INSERT INTO halls (hall_id, hall_name, capacity, total_rows, total_cols)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       hall_name=VALUES(hall_name), capacity=VALUES(capacity),
       total_rows=VALUES(total_rows), total_cols=VALUES(total_cols)`,
    [hall_id, hall_name, capacity, total_rows, total_cols]
  );
  return r;
};

const getAllHalls = async () => {
  const [r] = await pool.execute(`SELECT * FROM halls ORDER BY hall_id`);
  return r;
};

const getHallById = async (hall_id) => {
  const [r] = await pool.execute(`SELECT * FROM halls WHERE hall_id=?`, [hall_id]);
  return r[0] || null;
};

const deleteHall = async (hall_id) => {
  const [r] = await pool.execute(`DELETE FROM halls WHERE hall_id=?`, [hall_id]);
  return r;
};

const getTotalCapacity = async () => {
  const [r] = await pool.execute(`SELECT COALESCE(SUM(capacity),0) AS total FROM halls`);
  return r[0].total;
};

// ============================================
// STUDENTS
// ============================================
const insertStudent = async (student_id, student_name, subject_code) => {
  const [r] = await pool.execute(
    `INSERT IGNORE INTO students (student_id, student_name, subject_code) VALUES (?,?,?)`,
    [student_id, student_name, subject_code]
  );
  return { inserted: r.affectedRows > 0 };
};

// ✅ OPTIMIZED — single query instead of N queries
const bulkInsertStudents = async (students) => {
  if (!students.length) return { inserted: 0, duplicates: 0, errors: [] };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const placeholders = students.map(() => '(?,?,?)').join(',');
    const values = students.flatMap(s => [s.student_id, s.student_name, s.subject_code]);

    const [result] = await conn.execute(
      `INSERT IGNORE INTO students (student_id, student_name, subject_code) VALUES ${placeholders}`,
      values
    );

    await conn.commit();

    const inserted   = result.affectedRows;
    const duplicates = students.length - inserted;
    return { inserted, duplicates, errors: [] };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const getAllStudents = async () => {
  const [r] = await pool.execute(`SELECT * FROM students ORDER BY subject_code, student_id`);
  return r;
};

const getStudentsGroupedBySubject = async () => {
  const [rows] = await pool.execute(
    `SELECT subject_code, student_id, student_name FROM students ORDER BY subject_code, student_id`
  );
  const grouped = {};
  for (const s of rows) {
    if (!grouped[s.subject_code]) grouped[s.subject_code] = [];
    grouped[s.subject_code].push(s);
  }
  return grouped;
};

const getTotalStudentCount = async () => {
  const [r] = await pool.execute(`SELECT COUNT(*) AS total FROM students`);
  return r[0].total;
};

const getStudentCountBySubject = async () => {
  const [r] = await pool.execute(
    `SELECT subject_code, COUNT(*) AS total FROM students GROUP BY subject_code ORDER BY subject_code`
  );
  return r;
};

const clearStudents = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM unallocated_students`);
    await conn.execute(`DELETE FROM seat_allocations`);
    await conn.execute(`DELETE FROM students`);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

// ============================================
// SEAT ALLOCATIONS
// ============================================

// ✅ OPTIMIZED — single query instead of N queries
const bulkInsertAllocations = async (allocations) => {
  if (!allocations.length) return { inserted: 0 };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const placeholders = allocations.map(() => '(?,?,?,?,?)').join(',');
    const values = allocations.flatMap(a => [
      a.student_id, a.hall_id, a.seat_row, a.seat_col, a.seat_label
    ]);

    await conn.execute(
      `INSERT INTO seat_allocations (student_id, hall_id, seat_row, seat_col, seat_label) VALUES ${placeholders}`,
      values
    );

    await conn.commit();
    return { inserted: allocations.length };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const getAllAllocations = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_seating_chart`);
  return r;
};

const getAllocationsByHall = async (hall_id) => {
  const [r] = await pool.execute(
    `SELECT * FROM v_seating_chart WHERE hall_id=? ORDER BY seat_row, seat_col`, [hall_id]
  );
  return r;
};

const deleteStudent = async (student_id) => {
  const [r] = await pool.execute("DELETE FROM students WHERE student_id = ?", [student_id]);
  return r;
};

const clearHalls = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM unallocated_students`);
    await conn.execute(`DELETE FROM seat_allocations`);
    await conn.execute(`DELETE FROM halls`);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

const clearAllocations = async () => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM unallocated_students`);
    await conn.execute(`DELETE FROM seat_allocations`);
    await conn.commit();
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
};

// ============================================
// UNALLOCATED STUDENTS
// ============================================

// ✅ OPTIMIZED — single query instead of N queries
const bulkInsertUnallocated = async (students) => {
  if (!students.length) return;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const placeholders = students.map(() => '(?,?,?,?)').join(',');
    const values = students.flatMap(s => [
      s.student_id,
      s.student_name || '',
      s.subject_code || '',
      s.reason || 'Capacity overflow'
    ]);

    await conn.execute(
      `INSERT IGNORE INTO unallocated_students (student_id, student_name, subject_code, reason) VALUES ${placeholders}`,
      values
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
};

const getUnallocatedStudents = async () => {
  const [r] = await pool.execute(
    `SELECT student_id, student_name, subject_code, reason, logged_at
     FROM unallocated_students ORDER BY subject_code, student_id`
  );
  return r;
};

// ============================================
// REPORTS
// ============================================
const getSubjectPerHall = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_subject_per_hall`);
  return r;
};

const getHallSummary = async () => {
  const [r] = await pool.execute(`SELECT * FROM v_hall_summary`);
  return r;
};

// ============================================
// ALLOCATION LOGS
// ============================================
const insertAllocationLog = async (log) => {
  const [r] = await pool.execute(
    `INSERT INTO allocation_logs
       (total_students, total_allocated, total_unallocated, constraint_violations, duration_ms, status, message)
     VALUES (?,?,?,?,?,?,?)`,
    [log.total_students, log.total_allocated, log.total_unallocated,
     log.constraint_violations || 0, log.duration_ms, log.status, log.message || null]
  );
  return r;
};

const getLatestLog = async () => {
  const [r] = await pool.execute(`SELECT * FROM allocation_logs ORDER BY run_at DESC LIMIT 1`);
  return r[0] || null;
};

const getAllLogs = async () => {
  const [r] = await pool.execute(`SELECT * FROM allocation_logs ORDER BY run_at DESC`);
  return r;
};

// ============================================
// USERS
// ============================================
const getAllUsers = async () => {
  const [r] = await pool.execute(
    `SELECT id, username, role, created_at FROM users ORDER BY id DESC`
  );
  return r;
};

const getUserByUsername = async (username) => {
  const [r] = await pool.execute(`SELECT * FROM users WHERE username=?`, [username]);
  return r[0] || null;
};

const createUser = async (username, password, role) => {
  const hashed = await bcrypt.hash(password, SALT_ROUNDS);
  const [r] = await pool.execute(
    `INSERT INTO users (username, password, role) VALUES (?,?,?)`,
    [username, hashed, role]
  );
  return r;
};

const updateUserPassword = async (username, newPassword) => {
  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const [r] = await pool.execute(
    `UPDATE users SET password=? WHERE username=?`, [hashed, username]
  );
  return r;
};

const deleteUser = async (id) => {
  const [r] = await pool.execute(`DELETE FROM users WHERE id=?`, [id]);
  return r;
};

// ============================================
// SESSIONS
// ============================================
const createSession = async (token, username, role) => {
  await pool.execute("INSERT INTO sessions (token, username, role) VALUES (?, ?, ?)", [token, username, role]);
};

const getSession = async (token) => {
  const [rows] = await pool.execute("SELECT * FROM sessions WHERE token = ?", [token]);
  return rows[0] || null;
};

const deleteSession = async (token) => {
  await pool.execute("DELETE FROM sessions WHERE token = ?", [token]);
};

const deleteSessionsByUsername = async (username) => {
  await pool.execute("DELETE FROM sessions WHERE username = ?", [username]);
};

const deleteExpiredSessions = async () => {
  await pool.execute(`DELETE FROM sessions WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`);
};

module.exports = {
  pool, bcrypt,
  upsertHall, getAllHalls, getHallById, deleteHall, getTotalCapacity,
  insertStudent, bulkInsertStudents, getAllStudents, getStudentsGroupedBySubject,
  getTotalStudentCount, getStudentCountBySubject, deleteStudent, clearStudents, clearHalls,
  bulkInsertAllocations, getAllAllocations, getAllocationsByHall, clearAllocations,
  bulkInsertUnallocated, getUnallocatedStudents,
  getSubjectPerHall, getHallSummary,
  insertAllocationLog, getLatestLog, getAllLogs,
  getAllUsers, getUserByUsername, createUser, deleteUser, updateUserPassword,
  createSession, getSession, deleteSession, deleteSessionsByUsername, deleteExpiredSessions,
};
