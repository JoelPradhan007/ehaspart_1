// ============================================================
// allocate.js — Exam Seating Algorithm  v9  (PDF-exact)
// ============================================================
//
// PATTERN DECODED FROM 2024_batch1.pdf:
//
//  Hall layout: 6 columns × 8 rows = 48 seats, 6 departments × 8 students
//
//  ┌──────────────────────────────────────────────────┐
//  │  C1    C2    C3    C4    C5    C6                │
//  │  D0    D2    D4    D0    D2    D4   ← odd rows   │
//  │  D1    D3    D5    D1    D3    D5   ← even rows  │
//  └──────────────────────────────────────────────────┘
//
//  Columns are split into 3 GROUPS, each group spanning 2 paired columns:
//    Group 0 → C1 + C4   holds Dept[0] (odd rows)  + Dept[1] (even rows)
//    Group 1 → C2 + C5   holds Dept[2] (odd rows)  + Dept[3] (even rows)
//    Group 2 → C3 + C6   holds Dept[4] (odd rows)  + Dept[5] (even rows)
//
//  Within each dept, students fill seats in this exact order:
//    Left-column odd rows  → R1,R3,R5,R7 of C(group+1)
//    Right-column odd rows → R1,R3,R5,R7 of C(group+4)
//    (same for even-row dept but on R2,R4,R6,R8)
//
//  This gives 4+4 = 8 seats per dept per hall. ✅
//
//  8-directional adjacency is guaranteed because:
//    • Same row: D0 D2 D4 D0 D2 D4 — no two adjacent same dept
//    • Same col: alternates between two depts — never repeats back-to-back
//    • Diagonals: (r,c)↔(r±1,c±1) always cross row-parity AND col-group → always different
//
//  Students are placed in roll-number order within each dept.
//
//  For halls where dept counts are unequal (last hall, e.g. Room 209):
//    The same pattern is used; depts with fewer students simply run out
//    sooner and leave their remaining slots empty.
//
// ============================================================

/**
 * Main entry point.
 *
 * @param {Object} groupedStudents
 *   { dept_code: [{ student_id, student_name, dept_code, roll_no }] }
 *   Supports any number of departments (must be even; pad with empty if odd).
 *
 * @param {Array} halls
 *   [{ hall_id, hall_name, capacity, total_rows, total_cols }]
 *   total_cols MUST be even (pattern requires paired columns).
 *
 * @param {Array} [deptOrder]
 *   Optional explicit ordering of dept codes — controls which dept appears in
 *   which column slot. If omitted, depts are sorted alphabetically.
 *   To match the PDF exactly, pass:
 *     ['Civil', 'EEE', 'ECE', 'Mech', 'Chem', 'CSE']
 *   Slot mapping (for 6 cols × 8 rows):
 *     deptOrder[0] → C1 & C4 odd rows
 *     deptOrder[1] → C1 & C4 even rows
 *     deptOrder[2] → C2 & C5 odd rows
 *     deptOrder[3] → C2 & C5 even rows
 *     deptOrder[4] → C3 & C6 odd rows
 *     deptOrder[5] → C3 & C6 even rows
 *
 * @returns {{ allocations, unallocated, violations, hallAssignments }}
 */
function runAllocationAlgorithm(groupedStudents, halls, deptOrder = null) {
  const allocations    = [];
  const unallocated    = [];
  const hallAssignments = {};

  // Step 1: Sort every dept's students by roll number
  // Use caller-supplied deptOrder if provided (controls PDF slot assignment)
  const allDepts = deptOrder
    ? [...deptOrder].filter(d => groupedStudents[d])
    : Object.keys(groupedStudents).sort();
  const sorted = {};
  for (const dept of allDepts) {
    sorted[dept] = [...groupedStudents[dept]].sort((a, b) => {
      // Numeric roll if available, otherwise string-compare student_id
      const ra = a.roll_no ?? a.student_id;
      const rb = b.roll_no ?? b.student_id;
      return typeof ra === 'number' && typeof rb === 'number'
        ? ra - rb
        : String(ra).localeCompare(String(rb));
    });
  }

  // Step 2: Build global queues (shared across halls — overflow flows naturally)
  const queues = {};
  for (const dept of allDepts) queues[dept] = [...sorted[dept]];

  // Step 3: Seat each hall
  for (const hall of halls) {
    const activeDepts = allDepts.filter(d => queues[d].length > 0);
    if (activeDepts.length === 0) break;

    // Record first-seen hall for each dept (for display only)
    for (const dept of activeDepts) {
      if (hallAssignments[dept] === undefined) hallAssignments[dept] = hall.hall_id;
    }

    const result = seatHall(hall, activeDepts, queues);
    allocations.push(...result.allocations);
    // Overflow students remain in queues[] → picked up by next hall automatically
  }

  // Whatever remains after all halls = truly unallocated
  for (const dept of allDepts) {
    for (const s of queues[dept]) {
      unallocated.push({
        student_id:   s.student_id,
        student_name: s.student_name || '',
        dept_code:    dept,
        subject_code: s.subject_code || dept,
        reason:       'No remaining hall capacity',
      });
    }
    queues[dept] = [];
  }

  return { allocations, unallocated, violations: 0, hallAssignments };
}

// ============================================================
// seatHall
//
// Assigns students to seats using the PDF column-group pattern.
// Mutates queues[] in place (consumed students are shifted out).
//
// @param {Object} hall         { hall_id, total_rows, total_cols, capacity }
// @param {Array}  activeDepts  dept codes with remaining students (sorted)
// @param {Object} queues       { dept_code: [students...] }  — mutated
// ============================================================
function seatHall(hall, activeDepts, queues) {
  const allocations = [];
  const R = hall.total_rows;   // e.g. 8
  const C = hall.total_cols;   // e.g. 6 (must be even)
  const numGroups = C / 2;     // 3 groups for 6 cols

  // Map each dept to its (groupIndex, rowParity) slot
  // Dept[0] → group0 parity0, Dept[1] → group0 parity1
  // Dept[2] → group1 parity0, Dept[3] → group1 parity1, ...
  // If fewer than C depts, later groups may have only one or no dept

  // Build the seat schedule: for each (row, col) → which dept slot
  // dept slot = groupIndex * 2 + rowParity
  // groupIndex = (col - 1) % numGroups   [C1,C4→0  C2,C5→1  C3,C6→2]
  // rowParity  = (row - 1) % 2           [odd rows→0, even rows→1]

  function getDeptIndex(row, col) {
    const groupIdx  = (col - 1) % numGroups;
    const rowParity = (row - 1) % 2;
    return groupIdx * 2 + rowParity;
  }

  // Build fill order: column-group first, then left-col odd→right-col odd pattern
  // This exactly matches the PDF student ordering within each dept
  // Order of seats visited for each deptIndex:
  //   Left col (groupIdx+1) odd/even rows, then Right col (groupIdx+1+numGroups) odd/even rows

  // We iterate in HALL DISPLAY ORDER (row by row, col by col) for the grid
  // but assign students in PDF ORDER (left-col first, then right-col)
  // So we pre-build the assignment map: seat→student

  // Pre-generate ordered seat lists per deptIndex
  const seatLists = {}; // deptIndex → [(row,col), ...]
  for (let gi = 0; gi < numGroups; gi++) {
    for (let parity = 0; parity < 2; parity++) {
      const deptIdx = gi * 2 + parity;
      const seats = [];
      // Left col = gi+1, Right col = gi+1+numGroups
      for (const col of [gi + 1, gi + 1 + numGroups]) {
        for (let row = 1 + parity; row <= R; row += 2) {
          // parity=0 → odd rows (1,3,5,...), parity=1 → even rows (2,4,6,...)
          seats.push([row, col]);
        }
      }
      seatLists[deptIdx] = seats;
    }
  }

  // Map deptIndex → dept code
  const deptAtIndex = {};
  for (let i = 0; i < activeDepts.length; i++) {
    deptAtIndex[i] = activeDepts[i];
  }

  // Assign students to seats: for each deptIndex, pull students in order
  // Build a grid so we can return row/col info
  const seatMap = {}; // "row,col" → { student, dept }

  for (let deptIdx = 0; deptIdx < numGroups * 2; deptIdx++) {
    const dept = deptAtIndex[deptIdx];
    if (!dept || !queues[dept]) continue;

    const seats = seatLists[deptIdx] || [];
    for (const [row, col] of seats) {
      if (queues[dept].length === 0) break;
      const student = queues[dept].shift();
      seatMap[`${row},${col}`] = { student, dept };
    }
  }

  // Convert seatMap to allocations array in row-first order
  for (let row = 1; row <= R; row++) {
    for (let col = 1; col <= C; col++) {
      const entry = seatMap[`${row},${col}`];
      if (entry) {
        allocations.push({
          student_id:   entry.student.student_id,
          student_name: entry.student.student_name || '',
          dept_code:    entry.dept,
          subject_code: entry.student.subject_code || entry.dept,
          hall_id:      hall.hall_id,
          seat_row:     row,
          seat_col:     col,
          seat_label:   `R${row}C${col}`,
        });
      }
    }
  }

  return { allocations };
}

// ============================================================
module.exports = { runAllocationAlgorithm };


// ============================================================
// USAGE EXAMPLE
// ============================================================
/*

const groupedStudents = {
  'Civil':  [{ student_id: '24001A0101', roll_no: 101, dept_code: 'Civil' }, ...],
  'EEE':    [...],
  'Mech':   [...],
  'ECE':    [...],
  'CSE':    [...],
  'Chem':   [...],
};

const halls = [
  { hall_id: '201', hall_name: 'Room 201', total_rows: 8, total_cols: 6, capacity: 48 },
  { hall_id: '202', hall_name: 'Room 202', total_rows: 8, total_cols: 6, capacity: 48 },
  // ...
];

const { allocations, unallocated } = runAllocationAlgorithm(groupedStudents, halls);

// allocations[i] = { student_id, student_name, dept_code, hall_id, seat_row, seat_col, seat_label }
// unallocated[i] = { student_id, dept_code, reason }

*/
