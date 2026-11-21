# Lint and type check

Two checks on `js/`, both in CI (`.github/workflows/pr-checks.yml`) and runnable locally:

```bash
npm run lint:js      # ESLint: every global a script uses is declared
npm run typecheck    # tsc: // @ts-check files against the database types
npm run gen:types    # regenerate types/db.d.ts after a schema change (Docker)
```

## ESLint: declared globals

`eslint.config.mjs` turns on one rule, `no-undef`, for `js/**/*.js` (not `js/vendor/`, `js/pdf/`, or `js/env.js`). The page scripts are classic scripts that share globals, so each file lists what it uses from other files in its header:

```js
/* global supabaseClient, AppError, formatCurrency, fetchAllRows */
```

Use plain names. `window.supabaseClient` is not a valid entry; ESLint ignores it. Browser globals (`document`, `fetch`, …) are already known. `supabaseLoginClient.js`, `chartClient.js` and `pdfPreviewClient.js` are esbuild entries and lint as ES modules.

## tsc: database types

`npm run typecheck` runs `scripts/typecheck.mjs`. It runs `tsc --noEmit` once per page, with exactly the scripts that page loads (from `_partials/app-pages.json`, in `scripts/build-html.mjs` order), using `jsconfig.json` for the compiler options (strict, except `noImplicitAny` and `useUnknownInCatchVariables`). All classic scripts share one global scope, so checking every page script together would give false "cannot redeclare" errors (for example `isAdmin` in both `credit.js` and `day-closing.js`). Pages whose own scripts are all unchecked are skipped. Errors in shared files are reported once.

```bash
npm run typecheck              # every page with a checked script
npm run typecheck -- salary    # only pages whose file name contains "salary"
```

Scripts a page loads later with `loadScript()` are listed in `LAZY` in `scripts/typecheck.mjs` (the credit page's `creditCustomer.js` and its siblings). Add to it when a page lazy-loads a new module.

Only files whose first line is `// @ts-check` report errors:

| Checked | Why |
|---------|-----|
| `js/utils.js` | Shared helpers every page calls |
| `js/fuelPnl.js` | Buying rates and P&L for dashboard, analysis and reports |
| `js/dsrQueries.js` | DSR, expense and receipt reads for dashboard, reports and analysis |
| `js/day-closing.js` | Day-closing RPCs and the detail-panel reads |
| `js/meterReading.js` | Daily meter sheet: `dsr_petrol` / `dsr_diesel` reads, `save_dsr_meter_row` |
| `js/expenses.js` | `add_expense` and the expense history |
| `js/salary.js` | Salary payments and payroll reads |
| `js/settings.js` | Settings writes (products, categories, staff, users) |
| `js/creditCustomer.js` | Credit customer page (lazy-loaded by `credit.js`) |

`types/globals.d.ts` types `supabaseClient` / `window.supabaseClient` as `SupabaseClient<Database>`, using `types/db.d.ts`. It also declares the globals that tsc cannot follow because they are assigned inside IIFEs (`AppError`, `PumpSettings`, …). These are typed `any` until the files that define them are checked too.

### What fails

| Mistake | Example |
|---------|---------|
| Unknown table or view | `.from("dsr_costt")` |
| Unknown column in a filter or order | `.eq("prodct", "petrol")` |
| Unknown column in `.select("…")`, once the row is read | `.select("date, recepts")` then `row.recepts` |
| Unknown or missing RPC argument | `.rpc("get_day_closing_breakdown", { p_dat })` |
| Unknown RPC | `.rpc("get_day_closing_breakdownx")` |
| Wrong insert / update payload | `.insert({ amout: 1 })` |

`fetchAllRows` is generic, so rows keep their column types through paging.

### Known gaps

- **jsonb RPC results are `any`.** RPCs like `get_day_closing_breakdown` and `save_day_closing` return `jsonb_build_object(...)`, which Postgres cannot describe, so the generator emits `Json`. `types/globals.d.ts` maps those returns to `any`. The RPC name and arguments are still checked, but fields read from the result are not.
- **A select string built at runtime** (`.select(\`date, ${field}\`)`) only checks if `field` has a literal type. Annotate the source, as `SELLING_RATE_FIELD` in `dsrQueries.js` does.
- **`noImplicitAny` is off** (about 600 untyped parameters). Turn it on per file as JSDoc lands.

### Fixing an error

- DOM: `querySelector` returns `Element` and `event.target` is an `EventTarget`. Cast once: `const el = /** @type {HTMLInputElement | null} */ (document.getElementById("x"));`.
- A `let x = { data: null }` that is later given an object: annotate it, `/** @type {{ data: any }} */`.
- A real wrong column or argument: fix the code. Do not cast it away.

## After a schema change

`types/db.d.ts` is generated, so never edit it by hand. After updating `supabase/schema.sql`:

```bash
npm run gen:types                   # ./scripts/gen-db-types.sh
./scripts/gen-db-types.sh --check   # what CI runs: exit 1 if stale
```

The script starts the same throwaway Postgres image as `check-schema-drift.sh`, applies `schema.sql`, and runs Supabase's `postgres-meta` type generator (what `supabase gen types typescript` runs) in a second container. It never connects to staging or prod. Keep `PG_META_IMAGE` in step with the Supabase CLI.

## Widening the check

1. Add `// @ts-check` as line 1 of the file. The runner picks it up from `_partials/app-pages.json`; a lazily loaded script also needs a `LAZY` entry in `scripts/typecheck.mjs`.
2. `npm run typecheck -- <page>`, fix, and update the table above.
3. A global another script assigns inside an IIFE (`global.X = …`) shows as "Cannot find name". Declare it in `types/globals.d.ts`.

## Dependabot

`.github/dependabot.yml` opens weekly PRs into `staging` for npm (minor and patch dev dependencies grouped) and GitHub Actions. `@supabase/supabase-js` is a dev dependency only, for its types: the runtime client is the vendored `js/vendor/supabase.min.js` (2.39.3).
