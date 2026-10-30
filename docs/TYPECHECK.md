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

`jsconfig.json` sets up `tsc --noEmit` (strict, except `noImplicitAny` and `useUnknownInCatchVariables`). Only files whose first line is `// @ts-check` report errors:

| Checked | Why |
|---------|-----|
| `js/utils.js` | Shared helpers every page calls |
| `js/dsrQueries.js` | DSR, expense and receipt reads for dashboard, reports and analysis |
| `js/day-closing.js` | Day-closing RPCs and the detail-panel reads |

The other scripts in `jsconfig.json` `files` are there only so tsc can see the globals they define. They are the scripts `day-closing.html` loads (from `_partials/app-pages.json`) plus `purchaseTaxUtils.js`. All classic scripts share one global scope, so loading every page script together gives false "cannot redeclare" errors (for example `isAdmin` in both `credit.js` and `day-closing.js`).

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

1. Add `// @ts-check` as line 1 of the file.
2. If it is a page script, swap it in for `js/day-closing.js` in `jsconfig.json` `files` with its page's script set, or add a second config. Shared scripts can be added directly.
3. `npm run typecheck`, fix, and update the table above.

## Dependabot

`.github/dependabot.yml` opens weekly PRs into `staging` for npm (minor and patch dev dependencies grouped) and GitHub Actions. `@supabase/supabase-js` is a dev dependency only, for its types: the runtime client is the vendored `js/vendor/supabase.min.js` (2.39.3).
