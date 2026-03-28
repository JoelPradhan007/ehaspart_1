// ============================================
// Generatepdf.js — Advanced Seating PDF
// ============================================

const PDFDocument = require("pdfkit");

const PDF_COLORS = [
  "#FFDDC1","#C1E1FF","#C1FFCF","#FFF4C1",
  "#EAC1FF","#FFC1C1","#C1FFF4","#FFE4C1"
];

const colorMap = {};
let ci = 0;

function pdfColor(code) {
  if (!colorMap[code]) {
    colorMap[code] = PDF_COLORS[ci++ % PDF_COLORS.length];
  }
  return colorMap[code];
}

async function generatePDF(res, db) {

  const halls = await db.getAllHalls();
  const unallocated = await db.getUnallocatedStudents();
  const logs = await db.getLatestLog();

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=Seating_Chart_${Date.now()}.pdf`
  );

  const doc = new PDFDocument({
    margin: 30,
    size: "A4",
    layout: "landscape"
  });

  doc.pipe(res);

  const LEFT = 30;
  const BOTTOM = 30;
  let y = LEFT;

  function ensureSpace(heightNeeded) {
    if (y + heightNeeded > doc.page.height - BOTTOM) {
      doc.addPage();
      y = LEFT;
    }
  }

  // ================= HEADER =================

  doc.fontSize(16)
    .font("Helvetica-Bold")
    .text("Exam Seating Chart", LEFT, y);
  y += 20;

  doc.fontSize(8)
    .font("Helvetica")
    .text(`Generated: ${new Date().toLocaleString()}`, LEFT, y);
  y += 12;

  if (logs) {
    doc.text(
      `Students: ${logs.total_students} | Allocated: ${logs.total_allocated} | Unallocated: ${logs.total_unallocated} | Violations: ${logs.constraint_violations}`,
      LEFT,
      y
    );
    y += 15;
  }

  doc.moveTo(LEFT, y).lineTo(doc.page.width - LEFT, y).stroke();
  y += 20;

  // ================= HALLS =================

  let firstHall = true;

  for (const hall of halls) {

    if (!firstHall) {
      doc.addPage();
      y = LEFT;
    }
    firstHall = false;

    const allocs = await db.getAllocationsByHall(hall.hall_id);

    doc.fontSize(14)
      .font("Helvetica-Bold")
      .text(`Hall: ${hall.hall_id} (${hall.hall_name})`, LEFT, y);
    y += 16;

    doc.fontSize(9)
      .font("Helvetica")
      .text(
        `Capacity: ${hall.capacity} | Rows: ${hall.total_rows} | Cols: ${hall.total_cols} | Filled: ${allocs.length}`,
        LEFT,
        y
      );
    y += 20;

    const seatMap = {};
    for (const a of allocs) {
      seatMap[`${a.seat_row}-${a.seat_col}`] = a;
    }

    const LABEL_W = 25;
    const TOP_LABEL_H = 18;
    const CELL_H = 32;

    const usableWidth = doc.page.width - LEFT * 2 - LABEL_W - 2;
    const CELL_W = Math.floor(usableWidth / hall.total_cols);

    // ===== COLUMN NUMBERS =====

    doc.fontSize(7).font("Helvetica-Bold");

    for (let c = 1; c <= hall.total_cols; c++) {
      const x = LEFT + LABEL_W + 2 + (c - 1) * CELL_W;
      doc.text(`C${c}`, x, y, {
        width: CELL_W - 2,
        align: "center"
      });
    }

    y += TOP_LABEL_H;

    // ===== SEAT GRID =====

    for (let r = 1; r <= hall.total_rows; r++) {

      doc.fontSize(7)
        .font("Helvetica-Bold")
        .text(`R${r}`, LEFT, y + 12, {
          width: LABEL_W,
          align: "right"
        });

      for (let c = 1; c <= hall.total_cols; c++) {

        const x = LEFT + LABEL_W + 2 + (c - 1) * CELL_W;
        const seat = seatMap[`${r}-${c}`];

        doc.rect(x, y, CELL_W - 2, CELL_H).stroke();

        if (seat) {

          // Subject color header
          doc.rect(x, y, CELL_W - 2, 10)
            .fill(pdfColor(seat.subject_code))
            .stroke();

          doc.fill("black");

          doc.fontSize(6)
            .font("Helvetica-Bold")
            .text(seat.subject_code, x + 2, y + 1, {
              width: CELL_W - 6,
              align: "center"
            });

          doc.fontSize(5)
            .font("Helvetica")
            .text(seat.student_id, x + 2, y + 12, {
              width: CELL_W - 6,
              align: "center"
            });

          doc.fontSize(5)
            .text(seat.student_name.substring(0, 14), x + 2, y + 20, {
              width: CELL_W - 6,
              align: "center"
            });
        }
      }

      y += CELL_H + 2;

      // Overflow inside same hall
      if (y + CELL_H > doc.page.height - 40) {
        doc.addPage();
        y = LEFT;

        // redraw column numbers
        doc.fontSize(7).font("Helvetica-Bold");
        for (let c = 1; c <= hall.total_cols; c++) {
          const x = LEFT + LABEL_W + 2 + (c - 1) * CELL_W;
          doc.text(`C${c}`, x, y, {
            width: CELL_W - 2,
            align: "center"
          });
        }
        y += TOP_LABEL_H;
      }
    }
  }

  // ================= UNALLOCATED =================

  if (unallocated.length > 0) {
    doc.addPage();
    y = LEFT;

    doc.fontSize(16)
      .font("Helvetica-Bold")
      .fill("red")
      .text("Unallocated Students", LEFT, y);

    doc.fill("black");
    y += 25;

    for (const u of unallocated) {
      ensureSpace(20);

      doc.fontSize(9)
        .font("Helvetica")
        .text(
          `${u.student_id} | ${u.student_name} | ${u.subject_code}`,
          LEFT,
          y
        );

      y += 20;
    }
  }

  doc.end();
}

module.exports = { generatePDF };
