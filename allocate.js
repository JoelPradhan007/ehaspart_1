// ============================================================
// allocate_v11.js — Exam Seating Algorithm v11
// ============================================================
//
// CHANGES OVER v10:
//
//  OVERFLOW FILL (new):
//    After the main stripe allocation, if students remain
//    (overflow beyond capacity or dept exhausted its slots),
//    they are placed in any empty seat in the hall — even if
//    adjacent to the same dept. This ensures ALL students are
//    seated when total students <= total capacity.
//
//    Overflow seats are filled row-by-row, left-to-right,
//    skipping already-occupied seats.
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

  // ── Step 2: Sort each dept's students by student_id ──
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

  // ── Step 3: Per-hall quota — fill each slot to capacity ──
  const N = halls.length;
  const quotas = halls.map(() => ({}));

  for (const dept of allDepts) {
    let remaining = queues[dept].length;
    for (let i = 0; i < N; i++) {
      if (remaining === 0) {
        quotas[i][dept] = 0;
      } else if (i < N - 1) {
        const hall = halls[i];
        const numGroups = Math.floor(hall.total_cols / 2);
        const deptIdx = allDepts.indexOf(dept);
        const slotCapacity = deptIdx < numGroups * 2 ? hall.total_rows : 0;
        const quota = Math.min(remaining, slotCapacity);
        quotas[i][dept] = quota;
        remaining -= quota;
      } else {
        quotas[i][dept] = remaining;
        remaining = 0;
      }
    }
  }

  // ── Step 4: Seat each hall ──
  for (let hi = 0; hi < halls.length; hi++) {
    const hall = halls[hi];
    const hallQuota = quotas[hi];

    for (const dept of allDepts) {
      if (hallQuota[dept] > 0 && hallAssignments[dept] === undefined) {
        hallAssignments[dept] = hall.hall_id;
      }
    }

    const result = seatHall(hall, allDepts, queues, hallQuota);
    allocations.push(...result.allocations);

    const deptCounts = {};
    for (const a of result.allocations) {
      deptCounts[a.subject_code] = (deptCounts[a.subject_code] || 0) + 1;
    }
    summary.push({
      hall_id:    hall.hall_id,
      hall_name:  hall.hall_name,
      total:      result.allocations.length,
      dept_counts: deptCounts,
      violations: result.violations,
    });
  }

  // ── Step 5: Truly unallocated (exceeded total capacity) ──
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

  const totalViolations = summary.reduce((sum, h) => sum + h.violations, 0);
  return { allocations, unallocated, violations: totalViolations, hallAssignments, summary };
}


function seatHall(hall, allDepts, queues, hallQuota) {
  const allocations = [];
  const R = hall.total_rows;
  const C = hall.total_cols;
  const numGroups = Math.floor(C / 2);

  // ── Build stripe seat lists ──
  const seatLists = {};
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

  // ── Phase 1: Stripe allocation (no adjacent same-dept) ──
  const seatMap = {}; // "row,col" → { student, subject_code }

  for (let deptIdx = 0; deptIdx < allDepts.length && deptIdx < numGroups * 2; deptIdx++) {
    const dept = allDepts[deptIdx];
    if (!dept || !queues[dept]) continue;

    const allowed = hallQuota[dept] || 0;
    const seats   = seatLists[deptIdx] || [];
    let placed = 0;

    for (const [row, col] of seats) {
      if (placed >= allowed) break;
      if (queues[dept].length === 0) break;
      const student = queues[dept].shift();
      seatMap[`${row},${col}`] = { student, subject_code: dept };
      placed++;
    }
  }

  // ── Phase 2: Overflow fill ──
  // Any dept that still has students (due to slot exhaustion or last-hall overflow)
  // gets placed in remaining empty seats, row by row, regardless of adjacency.
  // This ensures all students within capacity are seated.
  const overflowQueue = [];
  for (const dept of allDepts) {
    const stillNeeded = hallQuota[dept] || 0;
    // Count how many were already placed for this dept in phase 1
    const alreadyPlaced = Object.values(seatMap)
      .filter(e => e.subject_code === dept).length;
    const stillDue = stillNeeded - alreadyPlaced;
    // Take remaining from queue up to stillDue
    for (let i = 0; i < stillDue && queues[dept].length > 0; i++) {
      overflowQueue.push({ student: queues[dept].shift(), subject_code: dept });
    }
  }

  if (overflowQueue.length > 0) {
    // Fill empty seats row by row, left to right
    for (let row = 1; row <= R && overflowQueue.length > 0; row++) {
      for (let col = 1; col <= C && overflowQueue.length > 0; col++) {
        if (!seatMap[`${row},${col}`]) {
          const { student, subject_code } = overflowQueue.shift();
          seatMap[`${row},${col}`] = { student, subject_code };
        }
      }
    }
  }

  // ── Convert seatMap to allocations ──
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
