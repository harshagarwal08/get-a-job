// Tracker export: CSV (RFC 4180), TSV (Google Sheets paste), JSON, XLSX (exceljs, lazy-loaded).
import { STATUSES } from './store.js';

export const COLUMNS = [
  { key: 'company', header: 'Company', width: 22, get: (a) => a.company },
  { key: 'role', header: 'Role', width: 32, get: (a) => a.role },
  { key: 'track', header: 'Track', width: 10, get: (a) => a.track },
  { key: 'status', header: 'Status', width: 14, get: (a) => a.status },
  { key: 'fitScore', header: 'Fit score', width: 10, get: (a) => a.fit?.score ?? null },
  { key: 'verdict', header: 'Verdict', width: 11, get: (a) => a.fit?.verdict ?? null },
  { key: 'channel', header: 'Channel', width: 11, get: (a) => a.channel },
  { key: 'location', header: 'Location', width: 20, get: (a) => a.location },
  { key: 'workMode', header: 'Work mode', width: 11, get: (a) => a.workMode },
  { key: 'applied', header: 'Applied date', width: 13, get: (a) => day(a.appliedAt) },
  { key: 'deadline', header: 'Deadline', width: 12, get: (a) => a.deadline },
  { key: 'nextAction', header: 'Next action', width: 32, get: (a) => a.nextAction },
  { key: 'nextActionDate', header: 'Next action date', width: 16, get: (a) => a.nextActionDate },
  { key: 'salary', header: 'Salary', width: 16, get: (a) => a.salary },
  { key: 'contact', header: 'Contact', width: 22, get: (a) => a.contact },
  { key: 'url', header: 'URL', width: 40, get: (a) => a.url },
  { key: 'resumePath', header: 'Resume path', width: 36, get: (a) => a.resumePath },
  { key: 'notes', header: 'Notes', width: 48, get: (a) => a.notes },
  { key: 'updatedAt', header: 'Last updated', width: 17, get: (a) => (a.updatedAt ? a.updatedAt.slice(0, 16).replace('T', ' ') : null) },
];

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

export function toRows(applications) {
  return applications.map((a) => COLUMNS.map((c) => c.get(a) ?? ''));
}

// Spreadsheet formula-injection guard (OWASP): text cells starting with = + @ tab CR, or '-' followed by a
// non-space non-digit, get an apostrophe. "- note" and "-5" stay intact.
export function guardFormula(v) {
  if (typeof v !== 'string') return v;
  return /^[=+@\t\r]/.test(v) || /^-[^\s\d]/.test(v) ? `'${v}` : v;
}

function csvCell(v) {
  const s = String(guardFormula(v ?? ''));
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(applications) {
  const lines = [COLUMNS.map((c) => csvCell(c.header)), ...toRows(applications).map((r) => r.map(csvCell))];
  return lines.map((l) => l.join(',')).join('\r\n') + '\r\n';
}

function tsvCell(v) {
  const s = String(guardFormula(v ?? '')).replace(/\t/g, ' ');
  return /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toTSV(applications) {
  const lines = [COLUMNS.map((c) => c.header), ...toRows(applications)].map((r) => r.map(tsvCell).join('\t'));
  return lines.join('\n') + '\n';
}

export function toJSON(applications) {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), applications }, null, 2) + '\n';
}

const STATUS_FILL = {
  saved: 'FFE2E8F0', drafted: 'FFEDE9FE', applied: 'FFDBEAFE', screening: 'FFCFFAFE', interview: 'FFFEF3C7',
  offer: 'FFDCFCE7', hired: 'FFA7F3D0', rejected: 'FFFFE4E6', withdrawn: 'FFF1F5F9', no_response: 'FFF5F5F4', offer_declined: 'FFFFEDD5',
};

export async function toXLSX(applications) {
  let ExcelJS;
  try {
    ExcelJS = (await import('exceljs')).default;
  } catch {
    throw new Error('xlsx export needs exceljs: run `npm install` in the repo root');
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'get-a-job';
  wb.created = new Date();
  const ws = wb.addWorksheet('Applications', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const a of applications) {
    const row = {};
    for (const c of COLUMNS) row[c.key] = guardFormula(c.get(a) ?? null);
    const r = ws.addRow(row);
    if (a.url && /^https?:\/\//i.test(a.url)) {
      const cell = r.getCell('url');
      cell.value = { text: a.url, hyperlink: a.url };
      cell.font = { color: { argb: 'FF4F46E5' }, underline: true };
    }
    const st = r.getCell('status');
    if (STATUS_FILL[a.status]) st.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[a.status] } };
    r.getCell('notes').alignment = { wrapText: true, vertical: 'top' };
    r.alignment = { vertical: 'top' };
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF312E81' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  ws.getColumn('status').eachCell((cell, n) => {
    if (n > 1) cell.dataValidation = { type: 'list', allowBlank: false, formulae: [`"${STATUSES.join(',')}"`] };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const FORMATS = {
  csv: { ext: 'csv', type: 'text/csv; charset=utf-8', render: toCSV },
  tsv: { ext: 'tsv', type: 'text/tab-separated-values; charset=utf-8', render: toTSV },
  json: { ext: 'json', type: 'application/json; charset=utf-8', render: toJSON },
  xlsx: { ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', render: toXLSX },
};

export async function exportApplications(applications, format) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown format "${format}" (csv, tsv, json, xlsx)`);
  return f.render(applications);
}
