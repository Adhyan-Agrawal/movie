/**
 * Pure CSV parser for the bulk-source importer (Spec Sections 9, 15).
 *
 * Deliberately dependency-free and side-effect-free: it only turns pasted CSV
 * text into row records with 1-based line numbers (so the importer can report
 * exactly which line failed). Everything semantically validated later — the
 * tmdb_id, season/episode numbers, and the URL are validated by the importer
 * action, NOT here. This module is safe to import from both server and client
 * bundles and is unit-testable on its own.
 */

/** One parsed line of the pasted CSV. `season`/`episode` stay raw strings so
 * the caller decides how to validate/interpret them. */
export interface BulkSourceRow {
  /** 1-based line number in the pasted text — used for per-row error messages. */
  line: number;
  tmdbId: string;
  season: string;
  episode: string;
  url: string;
  label: string;
  language: string;
  quality: string;
}

/** Columns, in order: tmdb_id, season, episode, url, label, language, quality. */
const EXPECTED_HEADER = 'tmdb_id';

/** Split ONE CSV line into cells, honoring double-quoted fields and `""` escapes. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

/**
 * Parse pasted CSV into {@link BulkSourceRow} records.
 *
 * - Blank/whitespace-only lines are skipped.
 * - A leading header line (`tmdb_id,…`) is detected and skipped.
 * - A UTF-8 BOM on the first line is stripped.
 * - Rows keep their 1-based line number for actionable error messages.
 */
export function parseBulkSourceCsv(raw: string): BulkSourceRow[] {
  const rows: BulkSourceRow[] = [];
  // Strip a UTF-8 BOM that some editors/CSV exports prepend to the first cell.
  const source = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let firstDataLine = true;

  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i] ?? '').map((cell) => cell.trim());

    // Blank line.
    if (cells.length === 1 && cells[0] === '') continue;

    // Optional header row — skip it so it never imports as a data row.
    if (firstDataLine && cells[0]?.toLowerCase() === EXPECTED_HEADER) {
      firstDataLine = false;
      continue;
    }
    firstDataLine = false;

    rows.push({
      line: i + 1,
      tmdbId: cells[0] ?? '',
      season: cells[1] ?? '',
      episode: cells[2] ?? '',
      url: cells[3] ?? '',
      label: cells[4] ?? '',
      language: cells[5] ?? '',
      quality: cells[6] ?? '',
    });
  }
  return rows;
}
