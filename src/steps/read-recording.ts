import { Driver, openOrder } from "./driver";

/**
 * Read-only: the order's Recording page ("Recorded Documents" table:
 * Document | Recorded Date | Disclosed Fee | Actual Fee). Qualia's API has
 * no recording data, so this is where the closeout workflow gets each
 * recorded instrument's date and time -- the owner policy's effective
 * date/time comes from the deed's row, the lender policy's from the deed of
 * trust's (matching is done on the Python side, post_closing/closeout/rules.py).
 */
export interface RecordedInstrument {
  document: string;
  /** As shown, e.g. "10/19/2026 at 8:01 AM". */
  recorded: string;
  instrumentNumber?: string;
}

export interface ReadRecordingResult {
  status: "read" | "error";
  instruments?: RecordedInstrument[];
  detail?: string;
}

export async function readRecordingStep(d: Driver, orderId: string): Promise<ReadRecordingResult> {
  await openOrder(d, orderId, "recording");
  const found = await d.waitFor(
    `Array.from(document.querySelectorAll('th, thead td')).some(function(h){ return /recorded date/i.test(h.textContent || ''); })`,
    20_000
  );
  if (!found) return { status: "error", detail: 'No "Recorded Date" table on the Recording page.' };
  d.note("Reading the Recorded Documents table");
  await d.show("table", "Read recorded documents and their dates");
  const raw = await d.evaluate<string>(`
    (function() {
      var norm = function(s) { return (s || '').replace(/\\s+/g, ' ').trim(); };
      var tables = Array.from(document.querySelectorAll('table'));
      for (var t = 0; t < tables.length; t++) {
        var headers = Array.from(tables[t].querySelectorAll('th, thead td')).map(function(h) { return norm(h.textContent).toLowerCase(); });
        var docCol = headers.indexOf('document');
        var dateCol = headers.indexOf('recorded date');
        if (docCol === -1 || dateCol === -1) continue;
        // Each document row can be followed by an expanded detail row
        // ("Instrument Number | 10212026-0110", seen live 2026-10-22) -- fold
        // those into the document above instead of treating them as documents.
        var rows = [];
        Array.from(tables[t].querySelectorAll('tbody tr')).forEach(function(tr) {
          var cells = tr.querySelectorAll('td');
          var doc = norm(cells[docCol] && cells[docCol].textContent);
          var rec = norm(cells[dateCol] && cells[dateCol].textContent);
          if (!doc) return;
          var num = rec.match(/Instrument Number\s*(\S+)/i);
          if (/^instrument number$/i.test(doc)) {
            if (rows.length && !rows[rows.length - 1].instrumentNumber) rows[rows.length - 1].instrumentNumber = rec;
            return;
          }
          var row = { document: doc, recorded: rec.replace(/\s*Instrument Number.*$/i, '') };
          if (num) row.instrumentNumber = num[1];
          rows.push(row);
        });
        return JSON.stringify({ rows: rows, headers: headers });
      }
      return JSON.stringify({ error: 'table with Document + Recorded Date columns not found' });
    })()
  `);
  const parsed = JSON.parse(raw) as { rows?: RecordedInstrument[]; error?: string };
  if (parsed.error) return { status: "error", detail: parsed.error };
  for (const r of parsed.rows ?? []) d.note(`Recorded: ${r.document} -- ${r.recorded}`);
  return { status: "read", instruments: parsed.rows ?? [] };
}
