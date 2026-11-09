/** RFC 4180 cells exactly as written, header row included. Rows with nothing in them are left out. */
export function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export const csvKey = (header: string) => header.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** RFC 4180 rows, first row as lower-case headers. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const [head, ...rest] = readCsv(text);
  if (!head) return [];
  const keys = head.map(csvKey);
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** The headers a list of companies usually carries its website under, in the order they are tried. */
const DOMAIN_HEADERS = ['domain', 'website', 'url', 'site', 'company_domain', 'company_website', 'website_url', 'company_url', 'domain_name', 'web', 'homepage'];
/** The company's website in a row, under whichever of the usual headers has a value. */
export const domainOf = (row: Record<string, string>) => DOMAIN_HEADERS.map((k) => row[k]).find(Boolean) ?? '';

/** Which column holds the websites: one under a usual header, or else the one whose cells mostly are domains. -1 when none does. */
export function domainColumn(head: string[], rows: string[][]): number {
  const keys = head.map(csvKey);
  for (const h of DOMAIN_HEADERS) { const i = keys.indexOf(h); if (i >= 0) return i; }
  let best = -1; let bestShare = 0.5;
  keys.forEach((_, i) => {
    const filled = rows.map((r) => (r[i] ?? '').trim()).filter(Boolean);
    const share = filled.length ? filled.filter((v) => normalizeDomain(v)).length / filled.length : 0;
    if (share > bestShare) { best = i; bestShare = share; }
  });
  return best;
}

export function normalizeDomain(input: string): string | null {
  const v = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]!;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v) ? v : null;
}
