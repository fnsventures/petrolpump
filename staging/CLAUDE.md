# CLAUDE.md

Guide for AI agents (and humans) working in this repo. Bishnupriya Fuels: petrol pump operations app. Static HTML/CSS/vanilla JS on GitHub Pages; Supabase (Postgres + RLS + RPCs + Auth + Edge Functions) backend. Prod = `main`, staging = `staging` (`/staging/`), two separate Supabase projects.

Docs index: [docs/README.md](docs/README.md). Task recipes: [docs/CHECKLISTS.md](docs/CHECKLISTS.md).

## Commands

```bash
npm ci
npm test                             # tax, GSTR, payroll, day-closing, and query paging
npm run dev                          # build:site + serve http://localhost:3000 (needs js/env.js)
npm run lint:css                     # no new hardcoded colours (use css/tokens.css)
npm run lint:js                      # ESLint no-undef against each file's /* global */ header
npm run typecheck                    # tsc per page on // @ts-check files vs types/db.d.ts (-- <page> for one)
npm run gen:types                    # regenerate types/db.d.ts from schema.sql (Docker)
npm run check:sql                    # supabase/functions-sql/ == schema.sql == newest migration
node scripts/check-doc-links.mjs     # Markdown links/anchors
./scripts/check-migration-order.sh   # new migrations sort after origin/staging's newest
./scripts/check-schema-drift.sh      # migrations vs supabase/schema.sql (Docker)
./scripts/test-db.sh                 # pgTAP in supabase/tests: day-closing totals, locks, request ids, RLS (Docker)
```

Verify UI by building (`npm run build:site`), `node --check` on edited JS, and clicking through `npm run dev` as admin and supervisor.

## Rules

- **Never run against prod or staging without being asked:** `./scripts/db.sh sync`, `migrate --apply`, `supabase db push`, `backup-prod-to-drive.sh`. `./scripts/db.sh migrate` (dry run) is read-only but still needs explicit OK.
- **Never read, print or commit** `scripts/db.env`, `js/env.js`, `scripts/.prod-backups/`, `scripts/.sync-dumps/` (real customer data and credentials).
- **Migrations:** create with `supabase migration new <name>`; never edit one already on `staging`/`main`; mirror changes into `supabase/schema.sql`. Details: [docs/MIGRATIONS.md](docs/MIGRATIONS.md).
- **Redefining an SQL function:** edit `supabase/functions-sql/<name>.sql` (the current definition, with its comment and grants), create the migration, then `node scripts/sql-functions.mjs emit <name>` — it appends the file to the newest migration and updates `schema.sql`. Never copy a body from an old migration: many are redefined repeatedly (`get_day_closing_breakdown` 23 times) and older copies are stale. `npm run check:sql` fails if a file, `schema.sql` and the newest defining migration disagree. See [docs/MIGRATIONS.md](docs/MIGRATIONS.md#redefine-a-function).
- **Money writes** go through the RPCs in `20261006054630_money_write_integrity` (`add_credit_entry`, `record_credit_payment`, `batch_record_credit_settlements`, `save_invoice`, `add_shift_expense`, `record_salary_payment`), plus `add_expense` (Expenses page) and `save_dsr_meter_row` (daily meter sheet) from `20261109154008_expense_and_meter_row_rpcs`. They take optional `p_request_id` and treat "today" as `meter_station_today()` (IST), not `current_date`. `add_credit_entry` and `record_credit_payment` lock the customer row before using prepaid or allocating a payment. Those RPCs, and the ledger and meter triggers, call `raise_if_day_closing_certified` so a certified day rejects the write. Don't insert or update invoices, expenses, salary rows, or `dsr_petrol`/`dsr_diesel` from the client.
- **Do not rename** the three `20250602*` migrations (date typo; already recorded on prod).
- **Security is server-side:** RLS + RPC role checks. Client role checks are UX only — any new table needs RLS; any new page needs a `check_page_access` branch.

## Frontend conventions

- One script per page (`meter-reading.html` → `js/meterReading.js`); shared code in `js/utils.js`, `js/auth.js`, `js/dsrQueries.js`, `js/errorHandler.js`, `js/cache.js`, `js/pageSections.js`.
- Pages contain body markup only. `<!-- @partial app-head -->` / `<!-- @partial app-topbar title="…" -->` are expanded at build by `scripts/build-html.mjs` from `_partials/`. Add CSS/JS to `_partials/app-pages.json`, never as copied `<script>` tags.
- Never add `?v=` to asset URLs, or edit `CACHE_VERSION` / `STATIC_ASSET_PATHS` in `sw.js` — `scripts/stamp-assets.mjs` generates them at deploy.
- No framework, no bundler for app code (esbuild only builds `js/vendor/` and minifies at deploy). Scripts are classic globals (`/* global … */` headers), not ES modules — except `js/supabaseLoginClient.js`, the esbuild entry for `js/vendor/supabase-login.min.js`.
- Every global a script uses from another script goes in its `/* global … */` header (plain names; `window.x` is not valid there). `npm run lint:js` fails otherwise.
- `// @ts-check` files (`utils.js`, `fuelPnl.js`, `dsrQueries.js`, `day-closing.js`, `meterReading.js`, `expenses.js`, `salary.js`, `settings.js`, `creditCustomer.js`) are type-checked against `types/db.d.ts`, once per page with that page's script set: a wrong table, column, filter or RPC argument fails `npm run typecheck`. New page scripts should start with `// @ts-check`. Narrow DOM types with JSDoc casts (`/** @type {HTMLInputElement} */ (el)`). [docs/TYPECHECK.md](docs/TYPECHECK.md).
- Errors: `AppError.report(err, { context })`. Markup: ``setHtml(el, html`…`)`` from `js/utils.js` — the `html` tag escapes every interpolated value; wrap markup that is already escaped in `trustedHtml(…)`. `npm run lint:js` warns on any other `innerHTML` / `outerHTML` / `insertAdjacentHTML` write.
- Display money with `formatCurrency` (`js/utils.js`). Totals that must match the server (day closing, credit) are computed in SQL RPCs — don't re-derive them in JS.

## Where things are

| Need | Look in |
|------|---------|
| Page → tables/RPCs it writes | [docs/FLOWS.md](docs/FLOWS.md) |
| Tables, RLS, RPCs | [docs/DATA_TABLES.md](docs/DATA_TABLES.md), latest migrations |
| Meter / DSR / stock model | [docs/DATA_TABLES.md](docs/DATA_TABLES.md) (`dsr_petrol`, `dsr_stock`) |
| Day-closing formula | [docs/DAY_CLOSING.md](docs/DAY_CLOSING.md) |
| Secrets (names only) | [docs/SECRETS.md](docs/SECRETS.md) |
| Release / restore | [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/RECOVERY.md](docs/RECOVERY.md) |
| Symptom → fix | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |

## Before finishing a change

- [ ] `node --check` on edited JS; `npm test`; `npm run build:site` succeeds
- [ ] `npm run lint:js` and `npm run typecheck` pass
- [ ] Schema change → migration + `schema.sql` + `npm run check:sql` + DATA_TABLES.md + `npm run gen:types`; `./scripts/test-db.sh` passes
- [ ] New page / function / secret → follow [docs/CHECKLISTS.md](docs/CHECKLISTS.md)
- [ ] Docs touched → `node scripts/check-doc-links.mjs`
