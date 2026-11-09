import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App } from './app.js';
import { answersFor, askCompany, unanswered } from './ask.js';
import { findContacts, HunterRefused } from './contacts.js';
import { csvKey, domainColumn, normalizeDomain, readCsv } from './csv.js';
import { all, logEvent, one } from './db.js';
import { BudgetExhausted } from './model.js';
import { csvCell } from './pack.js';
import { addCompany, FREE_MAIL, getIcp, isOwnDomain, learnIcp, learnProduct, OwnCompany, researchCompany, titleFit } from './pipeline.js';
import { pool, WORKERS } from './start.js';

export type EnrichOptions = { file: string; asks: string[]; out?: string; yes?: boolean; brief?: string };

/** Model calls for one company that has not been read: the research and the verdict. The count is a ceiling, as a site that cannot be read costs none. */
const CALLS_TO_RESEARCH = 2;
const UNLIMITED = 1_000_000;
const NAME_HEADERS = ['name', 'company', 'company_name'];
const CONTACT_SOURCES = ['imported', 'published', 'verified'];

/** Where the enriched copy goes: next to the list, with .enriched before the extension. */
export const enrichedPath = (file: string) => resolve(/\.csv$/i.test(file) ? file.replace(/\.csv$/i, '.enriched.csv') : `${file}.enriched.csv`);

// The person's own columns come back as they were written: only what Outlevo adds is guarded against a spreadsheet running a formula.
const plainCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

type Row = { cells: string[]; domain: string | null; skip: string | null };

/** The rows of the list, and which of them are no company to research. */
function readList(a: App, file: string) {
  const [head, ...data] = readCsv(readFileSync(file, 'utf8'));
  if (!head) throw new Error(`${file} is empty`);
  const col = domainColumn(head, data);
  if (col < 0) throw new Error(`No website column in ${file}. Name one of its columns domain, website or url.`);
  const nameCol = head.findIndex((h) => NAME_HEADERS.includes(csvKey(h)));
  const rows = data.map((cells): Row => {
    const raw = (cells[col] ?? '').trim();
    const domain = normalizeDomain(raw);
    if (!raw) return { cells, domain: null, skip: 'no website' };
    if (!domain) return { cells, domain: null, skip: 'not a domain' };
    if (FREE_MAIL.has(domain)) return { cells, domain: null, skip: 'a personal email service, not a company' };
    if (isOwnDomain(a, domain)) return { cells, domain: null, skip: 'your own company' };
    return { cells, domain, skip: null };
  });
  const names = new Map<string, string>();
  for (const r of rows) if (r.domain && nameCol >= 0 && !names.has(r.domain) && (r.cells[nameCol] ?? '').trim()) names.set(r.domain, r.cells[nameCol]!.trim());
  return { head, rows, domains: [...new Set(rows.flatMap((r) => (r.domain ? [r.domain] : [])))], names };
}

/** What a run would cost, from what is already in this folder: a company read before is not paid for twice. */
export function planEnrich(a: App, domains: string[], asks: string[]) {
  const known = (d: string) => one<{ id: number; status: string }>(a.db, 'select id, status from companies where domain = ?', d);
  const toResearch = domains.filter((d) => { const c = known(d); return !c || c.status === 'new' || c.status === 'error'; });
  const toAsk = asks.length ? domains.filter((d) => { const c = known(d); return !c || unanswered(a, c.id, asks).length > 0; }) : [];
  const setup = (one(a.db, 'select 1 from product') ? 0 : 1) + (getIcp(a) ? 0 : 1);
  const calls = setup + toResearch.length * CALLS_TO_RESEARCH + toAsk.length;
  const hunter = !!a.secrets.hunter_key;
  const lines = [`${domains.length} ${domains.length === 1 ? 'company' : 'companies'}: up to ${calls} model calls (${[
    ...(setup ? [`${setup} to learn your product and who to sell to`] : []),
    `${toResearch.length * CALLS_TO_RESEARCH} to research ${toResearch.length} not read before`,
    ...(asks.length ? [`${toAsk.length} to answer your ${asks.length === 1 ? 'question' : 'questions'}`] : []),
  ].join(', ')}). A site that cannot be read costs none, and what was done before is not paid for twice.`,
  ...(hunter ? ['Your Hunter key looks up the right person at each company that fits.'] : [])];
  return { calls, toResearch: toResearch.length, toAsk: toAsk.length, setup, hunter, lines };
}

/**
 * Researches every company in a list from its own site and writes the list back with new columns: whether it fits, why with its
 * quote and source, who to write to, and the answer to each of your questions. Nothing is written to anyone, and a fact is kept only if its quote is on the page.
 */
export async function enrich(a: App, o: EnrichOptions, say: (line: string) => void, confirm: (plan: string) => Promise<void>) {
  const list = readList(a, o.file);
  const out = o.out ? resolve(o.out) : enrichedPath(o.file);
  if (out === resolve(o.file)) throw new Error('The enriched copy would replace your list. Choose another file with --out');
  if (!list.domains.length) throw new Error(`No company to research in ${o.file}: ${[...new Set(list.rows.map((r) => r.skip))].join(', ') || 'no rows'}`);
  if (!one(a.db, 'select 1 from product') && !a.config.website) throw new Error('Which product is this for? Run outlevo start https://yourcompany.com first, or add --website https://yourcompany.com');

  const plan = planEnrich(a, list.domains, o.asks);
  if (o.yes || !plan.calls) say(plan.lines.join('\n'));
  else await confirm(plan.lines.join('\n'));

  const stopped = (e: unknown) => { if (e instanceof BudgetExhausted) throw e; return (e as Error).message; };
  let stoppedEarly: string | null = null;
  const ids = new Map<string, number>();
  for (const d of list.domains) {
    try { ids.set(d, addCompany(a, d, 'csv', list.names.get(d)).id); }
    catch (e) { if (!(e instanceof OwnCompany)) throw e; }
  }
  try {
    if (!one(a.db, 'select 1 from product')) { say('Reading your website…'); say(`  ${(await learnProduct(a)).summary}`); }
    if (!getIcp(a)) { say('Working out who buys…'); say(`  ${(await learnIcp(a, o.brief ? { brief: o.brief } : {})).summary}`); }

    const fresh = all<{ id: number; domain: string }>(a.db, "select id, domain from companies where status in ('new', 'error')").filter((c) => ids.get(c.domain) === c.id);
    if (fresh.length) say(`Researching ${fresh.length} companies from their own sites…`);
    await pool(fresh, WORKERS, async (c) => {
      try { const r = await researchCompany(a, c.id); say(`  ${c.domain}: ${r.status === 'qualified' ? 'fits' : r.status === 'disqualified' ? 'does not fit' : r.status}`); } catch (e) { say(`  ${c.domain}: ${stopped(e)}`); }
    });

    // Every company in the list gets the answers, whether it fits or not: the list is what you asked about.
    const toAsk = [...ids].filter(([, id]) => one<{ status: string }>(a.db, 'select status from companies where id = ?', id)?.status !== 'error' && unanswered(a, id, o.asks).length);
    if (toAsk.length) say(`Answering your ${o.asks.length === 1 ? 'question' : 'questions'} at ${toAsk.length} ${toAsk.length === 1 ? 'company' : 'companies'}…`);
    await pool(toAsk, WORKERS, async ([d, id]) => {
      try { const r = await askCompany(a, id, o.asks); say(`  ${d}: ${r.status === 'unreadable' ? 'site could not be read' : `${r.found} of ${r.asked} found`}`); } catch (e) { say(`  ${d}: ${stopped(e)}`); }
    });

    if (a.secrets.hunter_key) {
      say('Finding the right person at each company that fits, with your Hunter key…');
      try {
        const fits = [...ids.values()].filter((id) => one<{ status: string }>(a.db, 'select status from companies where id = ?', id)?.status === 'qualified');
        const r = await findContacts(a, { limit: UNLIMITED, companyIds: fits });
        say(`  ${r.added} verified, ${r.not_verified} not verified and left out${r.no_buyer ? `, ${r.no_buyer} with nobody in your buyer roles` : ''}.`);
      } catch (e) { if (!(e instanceof HunterRefused)) stopped(e); say(`  ${(e as Error).message}`); }
    }
  } catch (e) {
    // What is done is saved, so the day's limit is a pause: the list is still written with what is known.
    if (!(e instanceof BudgetExhausted)) throw e;
    stoppedEarly = e.message;
  }

  const result = writeEnriched(a, list, o.asks, out);
  logEvent(a.db, a.now(), 'list.enriched', { companies: list.domains.length, fit: result.fit, asks: o.asks.length });
  const s = result;
  const summary = `Enriched ${s.done} of ${list.domains.length} companies: ${s.fit} fit, ${s.not_fit} do not${s.unreadable ? `, ${s.unreadable} could not be read` : ''}${s.not_done ? `, ${s.not_done} not done yet` : ''}${s.skipped ? `. ${s.skipped} ${s.skipped === 1 ? 'row' : 'rows'} skipped, not a company` : ''}.${o.asks.length ? ` Answers found: ${s.answers_found} of ${s.answers_asked}.` : ''} Nothing was sent. ${out}`;
  say(`\n${summary}${stoppedEarly ? `\nStopped early: ${stoppedEarly}. Run this again tomorrow, or raise model.max_calls_per_day, and it carries on from here.` : ''}`);
  return { ...result, file: out, summary, stopped_early: stoppedEarly };
}

function writeEnriched(a: App, list: ReturnType<typeof readList>, asks: string[], out: string) {
  const icp = getIcp(a);
  const questionHeads = asks.flatMap((q) => [`answer: ${q}`, `answer: ${q} (quote)`, `answer: ${q} (source)`]);
  const added = ['outlevo_status', 'outlevo_fit', 'outlevo_score', 'outlevo_why', 'outlevo_quote', 'outlevo_source', 'outlevo_write_to', 'outlevo_contact_email', 'outlevo_contact_source', ...questionHeads];
  // A list that was enriched before comes back with its old new columns replaced, not repeated.
  const keep = list.head.map((h, i) => ({ h, i })).filter(({ h }) => !added.includes(h.trim()));
  const tally = { done: 0, fit: 0, not_fit: 0, unreadable: 0, not_done: 0, skipped: 0, answers_found: 0, answers_asked: 0 };
  const seen = new Set<string>();

  const lines = list.rows.map((r) => {
    const lead = added.length - questionHeads.length;
    const blank = (status: string) => [status, ...Array(lead - 1).fill('')] as string[];
    let extra: string[];
    if (!r.domain) { tally.skipped++; extra = [...blank(`skipped: ${r.skip}`), ...questionHeads.map(() => '')]; }
    else {
      const c = one<{ id: number; status: string; score: number | null; reasons: string | null; error: string | null }>(a.db, 'select id, status, score, reasons, error from companies where domain = ?', r.domain);
      const first = !seen.has(r.domain); seen.add(r.domain);
      const parsed = JSON.parse(c?.reasons ?? '{}') as { reasons?: Array<{ text: string; fact_id: number }>; missing?: string[] };
      const answers = c ? answersFor(a, c.id) : [];
      const answerCells = asks.flatMap((q) => { const x = answers.find((y) => y.question === q); return x?.found ? [x.answer, x.quote, x.source_url] : [x ? 'not found' : '', '', '']; });
      if (first && c) for (const q of asks) { const x = answers.find((y) => y.question === q); if (x) { tally.answers_asked++; if (x.found) tally.answers_found++; } }
      if (!c || c.status === 'new') { if (first) tally.not_done++; extra = [...blank('not done: stopped before this company'), ...answerCells]; }
      else if (c.status === 'error') { if (first) tally.unreadable++; extra = [...blank('site could not be read, or robots.txt refuses it'), ...answerCells]; }
      else {
        const fits = c.status === 'qualified';
        if (first) { tally.done++; if (fits) tally.fit++; else tally.not_fit++; }
        const top = fits ? parsed.reasons?.[0] : undefined;
        const fact = top ? one<{ quote: string; source_url: string }>(a.db, 'select quote, source_url from facts where id = ?', top.fact_id) : undefined;
        const why = fits ? (parsed.reasons ?? []).map((x) => x.text.trim().replace(/[.;]+$/, '')).join('; ') : (parsed.missing?.length ? `Not a fit: ${parsed.missing.join('; ')}` : (parsed.reasons ?? []).map((x) => x.text.trim()).join('; '));
        const buyers = icp?.buyer_titles ?? [];
        const person = fits ? all<{ first_name: string; last_name: string | null; title: string | null; email: string; email_source: string }>(a.db,
          `select first_name, last_name, title, email, email_source from contacts where company_id = ? and status = 'active' and email_source in (${CONTACT_SOURCES.map((s) => `'${s}'`).join(',')}) order by id`, c.id)
          .sort((x, y) => titleFit(y.title, buyers) - titleFit(x.title, buyers))[0] : undefined;
        const writeTo = person ? `${person.first_name} ${person.last_name ?? ''}`.trim() + (person.title ? `, ${person.title}` : '') : fits ? buyers[0] ?? '' : '';
        extra = [c.status === 'dropped' ? 'dropped by you' : 'done', c.status === 'qualified' ? 'yes' : c.status === 'dropped' ? 'dropped' : 'no', String(c.score ?? ''), why, fact?.quote ?? '', fact?.source_url ?? '', writeTo, person?.email ?? '', person?.email_source ?? '', ...answerCells];
      }
    }
    return [...keep.map(({ i }) => plainCell(r.cells[i] ?? '')), ...extra.map(csvCell)].join(',');
  });
  writeFileSync(out, [[...keep.map(({ h }) => plainCell(h)), ...added.map(csvCell)].join(','), ...lines].join('\n') + '\n');
  return tally;
}
