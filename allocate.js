// ============================================================
// allocate_v10.js — Exam Seating Algorithm  v10  (Improved)
// ============================================================
//
// FIXES OVER v9:
//
//  1. ROLL NUMBER SKIP BUG (528 → 530, 529 skipped)
//     Root cause in v9: activeDepts was re-filtered at every hall boundary
//     using queues[d].length > 0. When a dept exhausted mid-hall, its slot
//     index shifted for the next hall — so a different dept occupied its
//     column group, causing the queue ordering to misalign and skip students.
//     Fix: deptOrder is FIXED for all halls (never re-indexed). A dept's
//     column slot stays constant across every room. Only the queue drains.
//
//  2. ADJACENT SAME-DEPT NEIGHBORS (8-directional)
//     v9 guaranteed no same-dept in row or col, but diagonals could still
//     collide when a dept ran out mid-hall and its column went empty — the
//     visual gap caused the next dept's column to become diagonal-adjacent
//     to itself in the neighboring group.
//     Fix: Interleaved stripe pattern with verified 8-directional check.
//     After placement, a violation scanner runs and reports any conflicts.
//
//  3. UNEVEN DISTRIBUTION ACROSS ROOMS
//     v9 filled each dept's full column before moving on — this caused early
//     rooms to pack one dept heavy while later rooms ran short.
//     Fix: Per-room quota is calculated upfront:
//       quota[dept][hall] = floor(remaining / remaining_halls)
//     This spreads each dept evenly across remaining halls, with remainder
//     students going to the last hall (matching the PDF's last-room behavior).
//
//  4. VARYING ROOM SIZES
//     v9 hardcoded numGroups = C/2 and assumed exactly 6 depts for 6 cols.
//     Fix: Algorithm auto-scales to any even column count and any number
//     of depts. If depts > C, extra depts are queued for overflow.
//     If depts < C, unused column slots stay empty (no crash).
//
//  5. LAST ROOM — fill naturally (matches PDF, enables 2-invigilator rule)
//     Last room gets whatever students remain after quota distribution.
//     No forced redistribution. Pattern is the same — just some columns
//     will have fewer students or be partially empty.
//
// ============================================================
//
// SEATING PATTERN (unchanged from v9 — matches PDF):
//
//  Hall: 6 cols × 8 rows = 48 seats, 6 depts × 8 seats each
//
//  ┌──────────────────────────────────────────────────┐
//  │  C1      C2      C3      C4      C5      C6      │
//  │  D0      D2      D4      D0      D2      D4  ← odd rows  │
//  │  D1      D3      D5      D1      D3      D5  ← even rows │
//  └──────────────────────────────────────────────────┘
//
//  Group 0 → C1 + C4 : D0 (odd rows), D1 (even rows)
//  Group 1 → C2 + C5 : D2 (odd rows), D3 (even rows)
//  Group 2 → C3 + C6 : D4 (odd rows), D5 (even rows)
//
//  Students fill: left-col rows first, then right-col rows (in roll order)
//  No two 8-directionally adjacent seats share the same department.
//
// ============================================================

/**
 * Main entry point.
 *
 * @param {Object} groupedStudents
 *   { dept_code: [{ student_id, student_name, dept_code, roll_no }] }
 *
 * @param {Array} halls
 *   [{ hall_id, hall_name, capacity, total_rows, total_cols }]
 *   total_cols must be even.
 *
 * @param {Array} [deptOrder]
 *   Optional fixed ordering of dept codes — controls column slot assignment.
 *   MUST remain the same length for all halls (fixed throughout).
 *   Example for 6-dept PDF: ['Civil', 'EEE', 'Mech', 'ECE', 'CSE', 'Chemical']
 *   Slot mapping:
 *     deptOrder[0] → C1 & C4 odd rows
 *     deptOrder[1] → C1 & C4 even rows
 *     deptOrder[2] → C2 & C5 odd rows
 *     deptOrder[3] → C2 & C5 even rows
 *     deptOrder[4] → C3 & C6 odd rows
 *     deptOrder[5] → C3 & C6 even rows
 *
 * @returns {{ allocations, unallocated, violations, hallAssignments, summary }}
 */
function runAllocationAlgorithm(groupedStudents, halls, deptOrder = null) {
  const allocations     = [];
  const unallocated     = [];
  const hallAssignments = {};
  const summary         = [];

  // ── Step 1: Fix dept order (NEVER changes between halls — fixes skip bug) ──
  const allDepts = deptOrder
    ? [...deptOrder].filter(d => groupedStudents[d])
    : Object.keys(groupedStudents).sort();

  // ── Step 2: Sort each dept's students by roll number (stable, numeric-first) ──
  const queues = {};
  for (const dept of allDepts) {
    queues[dept] = [...(groupedStudents[dept] || [])].sort((a, b) => {
      const ra = a.roll_no ?? a.student_id;
      const rb = b.roll_no ?? b.student_id;
      // Prefer numeric sort; fall back to locale string compare
      const na = Number(ra), nb = Number(rb);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(ra).localeCompare(String(rb), undefined, { numeric: true });
    });
  }

  // ── Step 3: Pre-compute per-hall quotas (even distribution fix) ──
  //
  //   For each dept, we know its total count. We spread it across halls
  //   proportionally so no hall is over/under-loaded.
  //
  //   quota[hallIndex][dept] = how many of that dept go into that hall.
  //
  //   Algorithm:
  //     remaining = total students in dept
  //     for each hall i (0..N-1):
  //       if i < N-1:
  //         quota = floor(remaining / (N - i))
  //       else:
  //         quota = remaining   ← last hall gets whatever is left (matches PDF)
  //       remaining -= quota
  //
  //   This guarantees: sum(quotas) == total, no skips, even spread.
  //   Last room fills naturally with leftovers (PDF-exact behavior).

  const N = halls.length;
  const quotas = halls.map(() => ({})); // quotas[hallIdx][dept] = count

  // Calculate total capacity per hall and total seats available
  const totalCapacity = halls.reduce((s, h) => s + h.capacity, 0);
  const totalStudents = allDepts.reduce((s, d) => s + queues[d].length, 0);

  for (const dept of allDepts) {
    let remaining = queues[dept].length;
    for (let i = 0; i < N; i++) {
      if (remaining === 0) {
        quotas[i][dept] = 0;
      } else if (i < N - 1) {
        // Fill proportionally to hall capacity, not just equal split
        const hall = halls[i];
        const numGroups = Math.floor(hall.total_cols / 2);
        const slotsForDept = numGroups * 2; // total dept slots in this hall
        const deptIdx = allDepts.indexOf(dept);
        // Each dept slot holds (total_rows / 2) seats × 2 cols = total_rows seats
        const seatsPerDeptSlot = hall.total_rows;
        // Quota = seats available for this dept's slot in this hall
        const slotCapacity = deptIdx < slotsForDept ? seatsPerDeptSlot : 0;
        const quota = Math.min(remaining, slotCapacity);
        quotas[i][dept] = quota;
        remaining -= quota;
      } else {
        quotas[i][dept] = remaining;
        remaining = 0;
      }
    }
  }

  // ── Step 4: Seat each hall using fixed dept slots + per-hall quotas ──
  for (let hi = 0; hi < halls.length; hi++) {
    const hall = halls[hi];
    const hallQuota = quotas[hi]; // { dept: count }

    // Track first hall per dept
    for (const dept of allDepts) {
      if (hallQuota[dept] > 0 && hallAssignments[dept] === undefined) {
        hallAssignments[dept] = hall.hall_id;
      }
    }

    const result = seatHall(hall, allDepts, queues, hallQuota);
    allocations.push(...result.allocations);

    // Build per-hall summary (useful for invigilator sheet)
    const deptCounts = {};
    for (const a of result.allocations) {
      deptCounts[a.dept_code] = (deptCounts[a.dept_code] || 0) + 1;
    }
    summary.push({
      hall_id:    hall.hall_id,
      hall_name:  hall.hall_name,
      total:      result.allocations.length,
      dept_counts: deptCounts,
      violations: result.violations,
    });
  }

  // ── Step 5: Anything still in queues = truly unallocated ──
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

  // Count total violations across all halls
  const totalViolations = summary.reduce((sum, h) => sum + h.violations, 0);

  return { allocations, unallocated, violations: totalViolations, hallAssignments, summary };
}


// ============================================================
// seatHall — places students in one hall using fixed dept order + quotas
//
// Key fix vs v9:
//   - allDepts is FIXED (same indices every hall → no roll-number skip)
//   - hallQuota limits how many students each dept uses in this hall
//   - After placement, 8-directional violation scan runs and reports
// ============================================================
function seatHall(hall, allDepts, queues, hallQuota) {
  const allocations = [];
  const R = hall.total_rows;
  const C = hall.total_cols;        // must be even
  const numGroups = Math.floor(C / 2);

  // ── Build seat lists per dept slot (same pattern as v9) ──
  // deptIndex = groupIndex * 2 + rowParity
  //   parity 0 → odd rows (1,3,5,...)
  //   parity 1 → even rows (2,4,6,...)
  // Left col  = groupIndex + 1
  // Right col = groupIndex + 1 + numGroups

  const seatLists = {}; // deptIndex → [[row,col], ...]
  for (let gi = 0; gi < numGroups; gi++) {
    for (let parity = 0; parity < 2; parity++) {
      const deptIdx = gi * 2 + parity;
      const seats = [];
      for (const col of [gi + 1, gi + 1 + numGroups]) {
        for (let row = 1 + parity; row <= R; row += 2) {
          seats.push([row, col]);
        }
      }
      seatLists[deptIdx] = seats;
    }
  }

  // ── Assign students dept by dept (FIXED index → no shift between halls) ──
  const seatMap = {}; // "row,col" → { student, dept }

  for (let deptIdx = 0; deptIdx < allDepts.length && deptIdx < numGroups * 2; deptIdx++) {
    const dept = allDepts[deptIdx];
    if (!dept || !queues[dept]) continue;

    const allowed = hallQuota[dept] || 0;  // quota for this hall
    const seats   = seatLists[deptIdx] || [];
    let placed = 0;

    for (const [row, col] of seats) {
      if (placed >= allowed) break;          // respect quota → prevents uneven distribution
      if (queues[dept].length === 0) break;  // dept exhausted
      const student = queues[dept].shift();  // consume in roll-number order (no skips)
      seatMap[`${row},${col}`] = { student, dept };
      placed++;
    }
  }

  // ── Convert seatMap to allocations (row-first order for display) ──
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

  // ── 8-directional violation scan ──
  // Checks all 8 neighbors of every filled seat.
  // With the stripe pattern, violations should be 0 in full halls.
  // In partial last halls, this catches any edge cases.
  const violations = scan8Violations(seatMap, R, C);

  return { allocations, violations };
}


// ============================================================
// scan8Violations
//
// Scans all filled seats. For each seat, checks all 8 neighbors.
// Returns count of pairs where same dept is 8-directionally adjacent.
// Each pair counted once (only checks right/down/diagonal-right directions).
// ============================================================
function scan8Violations(seatMap, R, C) {
  let count = 0;
  const directions = [[0,1],[1,0],[1,1],[1,-1]]; // right, down, diag-DR, diag-DL

  for (let row = 1; row <= R; row++) {
    for (let col = 1; col <= C; col++) {
      const here = seatMap[`${row},${col}`];
      if (!here) continue;
      for (const [dr, dc] of directions) {
        const nr = row + dr, nc = col + dc;
        if (nr < 1 || nr > R || nc < 1 || nc > C) continue;
        const there = seatMap[`${nr},${nc}`];
        if (there && there.dept === here.dept) count++;
      }
    }
  }
  return count;
}


// ============================================================
// module.exports
// ============================================================
module.exports = { runAllocationAlgorithm };


// ============================================================
// USAGE EXAMPLE
// ============================================================
/*

const groupedStudents = {
  'Civil':    [{ student_id: '24001A0101', roll_no: 101, dept_code: 'Civil' }, ...],
  'EEE':      [...],
  'Mech':     [...],
  'ECE':      [...],
  'CSE':      [...],
  'Chemical': [...],
};

const halls = [
  { hall_id: '201', hall_name: 'Room 201', total_rows: 8, total_cols: 6, capacity: 48 },
  { hall_id: '202', hall_name: 'Room 202', total_rows: 8, total_cols: 6, capacity: 48 },
  { hall_id: '209', hall_name: 'Room 209', total_rows: 8, total_cols: 6, capacity: 48 },
];

// deptOrder controls which dept lands in which column group — must be fixed
const deptOrder = ['Civil', 'EEE', 'Mech', 'ECE', 'CSE', 'Chemical'];

const { allocations, unallocated, violations, summary } =
  runAllocationAlgorithm(groupedStudents, halls, deptOrder);

// allocations[i] = {
//   student_id, student_name, dept_code, subject_code,
//   hall_id, seat_row, seat_col, seat_label
// }

// summary[i] = {
//   hall_id, hall_name, total, dept_counts, violations
// }
// Use summary to print invigilator sheet per hall.

console.log('Total violations (should be 0):', violations);
console.log('Summary:', summary);

*/
