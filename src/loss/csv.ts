/**
 * CSV in and out, for a portfolio file the user picks and the results they download. Both run entirely in the
 * browser: nothing is uploaded, and no value read from a file is ever treated as markup (the UI writes it with
 * textContent) or as code.
 *
 * Reading follows RFC 4180 — quoted fields, "" escapes, commas and line breaks inside quotes, CRLF / LF / CR line ends —
 * plus what spreadsheets really write: a UTF-8 byte-order mark, a trailing newline, and semicolon- or tab-separated
 * files from locales that use the comma as a decimal mark. Hard caps bound the work a hostile file can cause.
 *
 * Writing quotes any field that needs it, and defuses spreadsheet formula injection (OWASP "CSV Injection"): a TEXT
 * cell starting with = + - @ tab or CR gets a leading apostrophe, so opening the export in Excel cannot run a formula
 * smuggled in through an asset name.
 */

export interface CsvLimits {
  /** Characters of input read at most. */
  maxChars: number;
  /** Data rows kept (the header is extra). */
  maxRows: number;
  maxCols: number;
  /** Characters per field. */
  maxFieldChars: number;
}

export const CSV_LIMITS: CsvLimits = { maxChars: 5_000_000, maxRows: 5000, maxCols: 64, maxFieldChars: 20_000 };

export interface CsvTable {
  delimiter: ',' | ';' | '\t';
  header: string[];
  rows: string[][];
  /** Rows dropped because of maxRows. */
  truncatedRows: number;
  /** Problems that did not stop parsing (over-long fields, extra columns). */
  warnings: string[];
  /** A problem that did (empty file, unterminated quote, too large). */
  error: string | null;
}

/** Pick the delimiter from the header line: comma unless it has none and a semicolon or tab instead. */
export function sniffDelimiter(firstLine: string): ',' | ';' | '\t' {
  if (firstLine.includes(',')) return ',';
  if (firstLine.includes(';')) return ';';
  if (firstLine.includes('\t')) return '\t';
  return ',';
}

export function parseCsv(input: string, limits: CsvLimits = CSV_LIMITS): CsvTable {
  const out: CsvTable = { delimiter: ',', header: [], rows: [], truncatedRows: 0, warnings: [], error: null };
  if (typeof input !== 'string') {
    out.error = 'Not a text file.';
    return out;
  }
  if (input.length > limits.maxChars) {
    out.error = `File too large (over ${Math.round(limits.maxChars / 1e6)} million characters).`;
    return out;
  }
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes('\u0000')) {
    out.error = 'This looks like a binary file, not CSV.';
    return out;
  }
  const firstBreak = text.search(/[\r\n]/);
  const delim = sniffDelimiter(firstBreak < 0 ? text : text.slice(0, firstBreak));
  out.delimiter = delim;

  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedField = false;
  let longField = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    if (field.length > limits.maxFieldChars) {
      field = field.slice(0, limits.maxFieldChars);
      longField = true;
    }
    if (row.length < limits.maxCols) row.push(field);
    field = '';
    quotedField = false;
  };
  const endRow = () => {
    endField();
    // Skip blank lines (a single empty unquoted field).
    if (!(row.length === 1 && row[0] === '')) {
      if (records.length <= limits.maxRows) records.push(row);
      else out.truncatedRows++;
    }
    row = [];
  };
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.length === 0 && !quotedField) {
      inQuotes = true;
      quotedField = true;
      i++;
      continue;
    }
    if (ch === delim) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    // A stray quote inside an unquoted field (or after a closing quote) is kept literally, as spreadsheets do.
    field += ch;
    i++;
  }
  if (inQuotes) {
    out.error = 'A quoted field is never closed (unbalanced " in the file).';
    return out;
  }
  if (field.length > 0 || row.length > 0) endRow();
  text = '';
  if (longField) out.warnings.push(`Some fields were longer than ${limits.maxFieldChars} characters and were cut.`);
  if (records.length === 0) {
    out.error = 'The file is empty.';
    return out;
  }
  out.header = records[0];
  out.rows = records.slice(1);
  if (records.some((r) => r.length >= limits.maxCols)) out.warnings.push(`Only the first ${limits.maxCols} columns are read.`);
  return out;
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type CsvValue = string | number | boolean | null | undefined;

/** One CSV field. Numbers are written plainly (NaN / Infinity as empty); text is formula-defused and quoted as needed. */
export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n;\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  const lines = [header.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
