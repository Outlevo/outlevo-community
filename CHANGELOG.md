# Changelog

## 0.2.0 (unreleased)

- `outlevo enrich <list.csv>`: researches the companies of your own list from their own sites and writes `list.enriched.csv` with your columns first, then whether each fits, why (with its quote and source), who to write to and the status. Contacts come only from a page that names them or from your own Hunter key. It prints an estimate of model calls and asks before it goes ahead (`--yes` skips the question), never pays twice for a company already researched, and respects `model.max_calls_per_day`. Name your site with `--website` if there was no `outlevo start` here.
- `--ask "question"` on `start` and `enrich`, repeatable up to 10 times: your own question answered for each company from its pages, with a quote and its source, or `not found`. An answer is kept only if its quote is on the page it names. In `enrich` the answers are CSV columns; in `start` they are in the pack's `index.html`, `companies.csv` and `emails/`.
- A list may name its website column `domain`, `website`, `url`, `site`, `company_domain`, `company_website` and a few more, in `companies import` and `--won`/`--lost` as well.

## 0.1.1

Published on npm: `npx outlevo start https://yourcompany.com`. The repository moved to the Outlevo organization.

- The local model tool is now the provider `local-cli`: `outlevo config set model.provider local-cli`. Change a config that used the old name.
- An example sales pack made from a fictional company, at https://outlevo.github.io/outlevo-community/.
- The README opens with one line, a demo GIF and a quick start that copies and runs.
- The package always builds before it is packed, so it never ships an old `dist`.

## 0.1.0

The first version: give it your website, get your sales pack.

**The sales pack**
- `outlevo start` reads your site, works out who to sell to, finds companies, researches them and writes three emails each, with every claim tied to a quote on the page it names.
- The ICP can come from up to 15 companies you won and 15 you lost.
- `outlevo rewrite` and `outlevo drop` change the pack in words.
- A connection note and a follow-up per company to send by hand from your own LinkedIn (`linkedin.md`). Nothing touches LinkedIn.

**Signals**
- Open roles from the Greenhouse, Lever or Ashby board a company's own site links to.
- SEC Form D filings, counted only when the issuer's name is the company's and its address or phone is on the company's own pages.
- `outlevo signals import`: posts you found yourself, which the first email and note can open on.

**From approved email to meeting**
- Contacts from your Hunter key or your own list, addressed to the people closest to your buyers.
- Sends only what you approve, from your own mailbox, with a ceiling of 50 a day.
- Reads replies, stops on an opt-out or a bounce, drafts answers with your booking link, and counts meetings from proven booking emails.
- `outlevo dashboard`: a local page with the funnel, the queue and what your model calls add up to.

**Outlevo Cloud, if you want it:** `outlevo cloud` finds contacts or hands a campaign over.
