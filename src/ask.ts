import { type App, arr, obj, S, UNTRUSTED } from './app.js';
import { all, logEvent, one, run } from './db.js';
import { quoteIsOn } from './fetcher.js';
import { pagesFor, readSite } from './pipeline.js';

export const MAX_ASKS = 10;
const MAX_ASK_CHARS = 300;
/** Pages read to answer: the usual ones, and where a question is likely to be answered. */
const ASK_PAGES = 8;
const ASK_WORTH: Array<[RegExp, number]> = [[/security|trust|compliance|privacy|legal|certif/, 4]];

export type Answer = { question: string; found: boolean; answer: string; quote: string; source_url: string };

/** What the person typed after --ask, tidied: no blanks, no repeats, nothing too long, and not more than the cost of a run can bear. */
export function cleanAsks(list: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const q = raw.replace(/\s+/g, ' ').trim();
    if (!q) throw new Error('--ask needs a question: outlevo start https://yourcompany.com --ask "Do they have SOC 2?"');
    if (q.length > MAX_ASK_CHARS) throw new Error(`A question can be up to ${MAX_ASK_CHARS} characters: ${q.slice(0, 40)}…`);
    if (!out.some((x) => x.toLowerCase() === q.toLowerCase())) out.push(q);
  }
  if (out.length > MAX_ASKS) throw new Error(`Up to ${MAX_ASKS} questions at a time, and you gave ${out.length}`);
  return out;
}

export const answersFor = (a: App, companyId: number) => all<{ question: string; found: number; answer: string; quote: string; source_url: string }>(a.db,
  'select question, found, answer, quote, source_url from answers where company_id = ? order by asked_at, rowid', companyId).map((r): Answer => ({ ...r, found: r.found === 1 }));

/** The questions this company has no answer to yet: an answer, "not found" included, is paid for once. */
export const unanswered = (a: App, companyId: number, asks: string[]) => asks.filter((q) => !one(a.db, 'select 1 from answers where company_id = ? and question = ?', companyId, q));

const words = (q: string) => [...new Set(q.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].filter((w) => !['they', 'have', 'does', 'what', 'which', 'their', 'with', 'from', 'that', 'this', 'there'].includes(w));
const digits = (s: string) => (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, '').replace(/,/g, ''));

/**
 * Answers the person's own questions about one company from its own pages. An answer is kept only if its quote is really on the
 * page it names, and a number in it is in the quote. Anything else is "not found", which says it was not on these pages, not that it is false.
 */
export async function askCompany(a: App, companyId: number, asks: string[]) {
  const c = one<{ id: number; domain: string }>(a.db, 'select id, domain from companies where id = ?', companyId);
  if (!c) throw new Error(`No company ${companyId}`);
  const todo = unanswered(a, c.id, asks);
  if (!todo.length) return { domain: c.domain, status: 'done' as const, asked: 0, found: 0 };
  // The words of the questions rank links too, so a question about SOC 2 reaches the security page.
  const pages = await readSite(a, c.domain, ASK_PAGES, [...ASK_WORTH, ...words(todo.join(' ')).map((w): [RegExp, number] => [new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 3])]);
  // A site that could not be read is not an answer: it is tried again next time.
  if (!pages.length) return { domain: c.domain, status: 'unreadable' as const, asked: 0, found: 0 };
  const r = await a.model().json<{ answers: Array<{ n: number; found: boolean; answer: string; quote: string; source_url: string }> }>({
    name: 'answer_questions', effort: 'medium',
    system: `You answer a salesperson's questions about a company, only from the pages of its own website that you are given. ${UNTRUSTED} Every answer carries a quote: a short sentence copied word for word from one page, and that page's exact URL. No quote on the page, no answer: set found to false. Do not infer, round or embellish, and do not treat the absence of a mention as a no.`,
    user: `Company: ${c.domain}\n\nQuestions:\n${todo.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n${pagesFor(pages)}`,
    schema: obj({ answers: arr(obj({ n: { type: 'integer' }, found: { type: 'boolean' }, answer: S, quote: S, source_url: S })) }),
  });
  let found = 0;
  const at = a.now().toISOString();
  todo.forEach((q, i) => {
    const x = r.answers.find((y) => y.n === i + 1);
    const page = x ? pages.find((p) => p.url === x.source_url) : undefined;
    const kept = !!x && x.found && !!page && quoteIsOn(x.quote, page.text) && x.answer.trim() !== '' && digits(x.answer).every((n) => digits(x.quote).includes(n));
    if (kept) found++;
    run(a.db, `insert into answers (company_id, question, found, answer, quote, source_url, asked_at) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (company_id, question) do update set found = excluded.found, answer = excluded.answer, quote = excluded.quote, source_url = excluded.source_url, asked_at = excluded.asked_at`,
    c.id, q, kept ? 1 : 0, kept ? x!.answer.trim() : '', kept ? x!.quote.trim() : '', kept ? x!.source_url : '', at);
  });
  logEvent(a.db, a.now(), 'company.asked', { domain: c.domain, asked: todo.length, found });
  return { domain: c.domain, status: 'done' as const, asked: todo.length, found };
}
