// ============================================================
// allocate_v11.js — Exam Seating Algorithm v11
// ============================================================
//
// SEATING PATTERN (6 cols × 8 rows, 6 depts):
//
//  Group 0 → C1+C4 : D0 odd rows,  D1 even rows
//  Group 1 → C2+C5 : D2 odd rows,  D3 even rows
//  Group 2 → C3+C6 : D4 odd rows,  D5 even rows
//
// OVERFLOW RULE:
//  After all halls are filled with the stripe pattern,
//  any students remaining (overflow beyond their stripe slots)
//  are placed in empty seats of the last hall in roll-number
//  order, row-by-row left-to-right. Adjacency constraint is
//  RELAXED for overflow seats only.
//
// ============================================================

function runAllocationAlgorithm(groupedStudents, halls, deptOrder = null) {
  const allocations     = [];
  const unallocated     = [];
  const hallAssignments = {};
  const summary         = [];

  // ── Step 1: Fix dept order ──
  const allDepts = deptOrder
    ? [...deptOrder].filter(d => groupedStudents[d])
    : Object.keys(groupedStudents).sort();

  // ── Step 2: Build sorted queues per dept ──
  const queues = {};
  for (const dept of allDepts) {
    queues[dept] = [...(groupedStudents[dept] || [])].sort((a, b) => {
      const ra = a.roll_no ?? a.student_id;
      const rb = b.roll_no ?? b.student_id;
      const na = Number(ra), nb = Number(rb);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(ra).localeCompare(String(rb), undefined, { numeric: true });
    });
  }

  const N = halls.length;

  // ── Step 3: Calculate stripe quota per dept per hall ──
  // Each dept has exactly one stripe slot per hall = total_rows seats.
  // Greedily fill: give dept min(remaining, total_rows) per hall.
  const stripeQuota = halls.map(() => ({}));
  for (const dept of allDepts) {
    let remaining = queues[dept].length;
    for (let i = 0; i < N; i++) {
      if (remaining === 0) { stripeQuota[i][dept] = 0; continue; }
      const hall     = halls[i];
      const numGroups = Math.floor(hall.total_cols / 2);
      const deptIdx  = allDepts.indexOf(dept);
      const hasSlot  = deptIdx < numGroups * 2;
      const slotCap  = hasSlot ? hall.total_rows : 0;
      const quota    = Math.min(remaining, slotCap);
      stripeQuota[i][dept] = quota;
      remaining -= quota;
    }
    // Note: if remaining > 0 after all halls, those are overflow students
    // They stay in the queue and will be placed after last hall stripe
  }

  // ── Step 4: Seat each hall with stripe pattern ──
  for (let hi = 0; hi < N; hi++) {
    const hall  = halls[hi];
    const quota = stripeQuota[hi];

    for (const dept of allDepts) {
      if (quota[dept] > 0 && hallAssignments[dept] === undefined) {
        hallAssignments[dept] = hall.hall_id;
      }
    }

    const result = seatHall(hall, allDepts, queues, quota);
    allocations.push(...result.allocations);

    const deptCounts = {};
    for (const a of result.allocations) {
      deptCounts[a.subject_code] = (deptCounts[a.subject_code] || 0) + 1;
    }
    summary.push({
      hall_id:     hall.hall_id,
      hall_name:   hall.hall_name,
      total:       result.allocations.length,
      dept_counts: deptCounts,
      violations:  result.violations,
    });
  }

  // ── Step 5: Place overflow students in empty seats of last hall ──
  // Collect all remaining students across all depts in roll-number order
  const overflowAll = [];
  for (const dept of allDepts) {
    while (queues[dept].length > 0) {
      overflowAll.push({ student: queues[dept].shift(), subject_code: dept });
    }
  }
  // Sort by student_id for consistent roll-number order
  overflowAll.sort((a, b) =>
    String(a.student.student_id).localeCompare(
      String(b.student.student_id), undefined, { numeric: true }
    )
  );

  if (overflowAll.length > 0) {
    const lastHallId = halls[N - 1].hall_id;
    const lastHall   = halls[N - 1];

    // Find which seats in last hall are already occupied
    const occupiedInLast = new Set(
      allocations
        .filter(a => a.hall_id === lastHallId)
        .map(a => `${a.seat_row},${a.seat_col}`)
    );

    // Get empty seats in last hall, row-by-row
    const emptySeats = [];
    for (let row = 1; row <= lastHall.total_rows; row++) {
      for (let col = 1; col <= lastHall.total_cols; col++) {
        if (!occupiedInLast.has(`${row},${col}`)) {
          emptySeats.push([row, col]);
        }
      }
    }

    // Place overflow students into empty seats in order
    for (let i = 0; i < overflowAll.length; i++) {
      if (i >= emptySeats.length) {
        // Truly exceeds capacity
        const { student, subject_code } = overflowAll[i];
        unallocated.push({
          student_id:   student.student_id,
          student_name: student.student_name || '',
          dept_code:    subject_code,
          subject_code: student.subject_code || subject_code,
          reason:       'No remaining hall capacity',
        });
        continue;
      }
      const [row, col] = emptySeats[i];
      const { student, subject_code } = overflowAll[i];
      allocations.push({
        student_id:   student.student_id,
        student_name: student.student_name || '',
        dept_code:    subject_code,
        subject_code: student.subject_code || subject_code,
        hall_id:      lastHallId,
        seat_row:     row,
        seat_col:     col,
        seat_label:   `R${row}C${col}`,
      });
      // Update last hall summary
      const lastSummary = summary[N - 1];
      lastSummary.total++;
      lastSummary.dept_counts[subject_code] = (lastSummary.dept_counts[subject_code] || 0) + 1;
    }
  }

  const totalViolations = summary.reduce((sum, h) => sum + h.violations, 0);
  return { allocations, unallocated, violations: totalViolations, hallAssignments, summary };
}


function seatHall(hall, allDepts, queues, hallQuota) {
  const R = hall.total_rows;
  const C = hall.total_cols;
  const numGroups = Math.floor(C / 2);

  // ── Build stripe seat lists ──
  const seatLists = {};
  for (let gi = 0; gi < numGroups; gi++) {
    for (let parity = 0; parity < 2; parity++) {
      const deptIdx = gi * 2 + parity;
      const seats   = [];
      for (const col of [gi + 1, gi + 1 + numGroups]) {
        for (let row = 1 + parity; row <= R; row += 2) {
          seats.push([row, col]);
        }
      }
      seatLists[deptIdx] = seats;
    }
  }

  // ── Stripe allocation ──
  const seatMap = {};
  for (let deptIdx = 0; deptIdx < allDepts.length && deptIdx < numGroups * 2; deptIdx++) {
    const dept    = allDepts[deptIdx];
    if (!dept || !queues[dept]) continue;
    const allowed = hallQuota[dept] || 0;
    const seats   = seatLists[deptIdx] || [];
    let placed    = 0;
    for (const [row, col] of seats) {
      if (placed >= allowed) break;
      if (queues[dept].length === 0) break;
      const student = queues[dept].shift();
      seatMap[`${row},${col}`] = { student, subject_code: dept };
      placed++;
    }
  }

  // ── Convert to allocations ──
  const allocations = [];
  for (let row = 1; row <= R; row++) {
    for (let col = 1; col <= C; col++) {
      const entry = seatMap[`${row},${col}`];
      if (entry) {
        allocations.push({
          student_id:   entry.student.student_id,
          student_name: entry.student.student_name || '',
          dept_code:    entry.subject_code,
          subject_code: entry.student.subject_code || entry.subject_code,
          hall_id:      hall.hall_id,
          seat_row:     row,
          seat_col:     col,
          seat_label:   `R${row}C${col}`,
        });
      }
    }
  }

  const violations = scan8Violations(seatMap, R, C);
  return { allocations, violations };
}


function scan8Violations(seatMap, R, C) {
  let count = 0;
  const directions = [[0,1],[1,0],[1,1],[1,-1]];
  for (let row = 1; row <= R; row++) {
    for (let col = 1; col <= C; col++) {
      const here = seatMap[`${row},${col}`];
      if (!here) continue;
      for (const [dr, dc] of directions) {
        const nr = row + dr, nc = col + dc;
        if (nr < 1 || nr > R || nc < 1 || nc > C) continue;
        const there = seatMap[`${nr},${nc}`];
        if (there && there.subject_code === here.subject_code) count++;
      }
    }
  }
  return count;
}

module.exports = { runAllocationAlgorithm };
