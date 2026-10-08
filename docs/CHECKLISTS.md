# Checklists

Copy the list into your PR description and tick it off. Every item names the exact file to touch.

**Before any PR:** branch from `staging`; PR into `staging`. CI (`.github/workflows/pr-checks.yml`) runs the build, JS syntax, doc links, migration order, and — if `supabase/` changed — the schema-drift check.

---

## Add a page

Example: `widgets.html` with script `js/widgets.js`.

- [ ] **HTML** — copy the shell of a similar page (e.g. `reminders.html`). Keep only the body markup; the head and topbar are partials:
  ```html
  <head>
    <!-- @partial app-head -->
  </head>
  <body class="widgets-page">
    <!-- @partial app-topbar title="Widgets" -->
  ```
- [ ] **Assets** — add a `"widgets.html"` entry to `_partials/app-pages.json` (`title`, `pageTitle`, `bodyClass`, `css`, `beforeAuth`, `page`). The build fails if a page uses `@partial app-head` without an entry. Never add `?v=` — hashes are stamped at build.
- [ ] **CSS** — `css/app-widgets.css` (listed in `css` above).
- [ ] **Script** — `js/widgets.js` starts with `requireAuth({ allowedRoles: [...], onDenied: "dashboard.html", pageName: "widgets" })`, then `applyRoleVisibility(auth.role)`. See `js/reminders.js`.
- [ ] **Server-side access** — new migration redefining `public.check_page_access` with a `when 'widgets' then …` branch. Copy the **latest** definition (`grep -lE "create( or replace)? function public\.check_page_access\b" supabase/migrations/* | sort | tail -1`). Without it the page denies everyone.
- [ ] **Navigation** — add `{ href: "widgets.html", label: "Widgets", icon: "…" }` to the right group in `NAV_GROUPS` (`js/appNav.js`). Admin-only groups use `adminOnly: true`.
- [ ] **Help panel** — add a `"widgets.html"` entry to `PAGE_HELP` in `js/auth.js`.
- [ ] **Docs** — page table in [ARCHITECTURE.md §3.1](ARCHITECTURE.md#31-root-and-pages) and §3.3; data writes in [FLOWS.md](FLOWS.md).
- [ ] **Test** — `npm run dev`, open `http://localhost:3000/widgets.html` as admin **and** supervisor.

---

## Add a migration

- [ ] `supabase migration new short_snake_description` — never hand-type a timestamp; the file must sort after every existing one ([MIGRATIONS.md → Naming](MIGRATIONS.md#naming)).
- [ ] Additive and safe: nullable/defaulted columns, `create or replace` functions, `if not exists` indexes. Destructive change → plan the rollback first ([RECOVERY.md → Schema rollback](RECOVERY.md#schema-rollback)).
- [ ] Redefining a function? Start from the **latest** migration that defines it (`grep -lE "create( or replace)? function public\.<name>\b" … | sort | tail -1`), not `schema.sql`, a `grant`, or a `comment on function`. Day-closing RPCs: [DAY_CLOSING.md](DAY_CLOSING.md).
- [ ] A money-writing RPC (`add_credit_entry`, `record_credit_payment`, `save_invoice`, `add_shift_expense`, `record_salary_payment`, and the batch settlement RPC) keeps optional `p_request_id` and calls `write_request_replay` / `write_request_store`. Future-date checks use `meter_station_today()`, not `current_date`. `add_credit_entry` and `record_credit_payment` lock the customer row (`for update`) before reading prepaid or allocating. Ledger and meter writes call `raise_if_day_closing_certified`. `authenticated` has no insert or update on `credit_entries` or `credit_payments`, and none on `amount_due`, `prepaid_balance`, or `amount_settled`. `day_closing` insert, update, and delete are denied on the client (`save_day_closing` / `delete_day_closing`). See [DATA_TABLES.md → write_requests](DATA_TABLES.md#write_requests).
- [ ] Changing a function's arguments? `drop function if exists public.fn(<old arg types>);` in the same migration, or the old version stays callable.
- [ ] New table → enable RLS and add policies; grant RPCs to `authenticated` only.
- [ ] Mirror the change in `supabase/schema.sql`; `./scripts/check-schema-drift.sh` passes (needs Docker).
- [ ] Update [DATA_TABLES.md](DATA_TABLES.md) if tables, RPCs, RLS, or the meter/stock model changed.
- [ ] Never edit a migration that is already on `staging`/`main`.
- [ ] PR template: tick **Needs `./scripts/db.sh migrate --apply`**.
- [ ] Staging first: `supabase db push --db-url "$STAGING_DB_URL"` ([MIGRATIONS.md → Staging schema only](MIGRATIONS.md#staging-schema-only)), or `./scripts/db.sh sync` if you also want prod data copied over.
- [ ] Release: test `/staging/` → `./scripts/db.sh migrate` → quiet window → `./scripts/db.sh migrate --apply` → merge to `main` ([OPERATIONS.md §3](OPERATIONS.md#3-release-to-production)).

---

## Add an edge function

Example: `get-widgets-data`.

- [ ] `supabase functions new get-widgets-data` → `supabase/functions/get-widgets-data/index.ts`. Copy CORS + auth handling from `supabase/functions/get-pl-data/index.ts`; Drive helpers live in `supabase/functions/_shared/`.
- [ ] Create the Supabase client with the **caller's** `Authorization` header so RLS still applies. Use the service-role key only when unavoidable, and check the caller's role first.
- [ ] **Register for deploy** — add the name to the `for fn in …` list in `.github/workflows/deploy-supabase-functions.yml`. Functions not in that list are never deployed.
- [ ] Function secrets → Supabase Dashboard → **Edge Functions → Secrets** on **both** projects; record them in [SECRETS.md](SECRETS.md).
- [ ] Client: call with `supabaseClient.functions.invoke("get-widgets-data", …)` and keep a direct-query fallback, as the dashboard does.
- [ ] Docs: function table in [ARCHITECTURE.md → Edge functions](ARCHITECTURE.md#65-edge-functions) and the tree in [§3.5](ARCHITECTURE.md#35-backend-supabase).
- [ ] Release: merge to `staging` deploys to staging automatically; merge to `main` deploys to prod. Deploy **before or with** the frontend that needs it.

---

## Add a user

Both steps are required — an Auth account alone sees empty pages.

- [ ] **Public sign-up off** — Supabase → **Authentication → Sign In / Up** (or Providers → Email) → disable **Allow new users to sign up**, on **both** prod and staging. A new project turns this on. The app cannot change it. Settings no longer calls `signUp`.
- [ ] **Auth** — Supabase → **Authentication → Users → Add user** (email + password), in the right project (prod or staging).
- [ ] **App role** — an admin adds the email under **Settings → Users** (calls `upsert_staff`), choosing `admin` or `supervisor`. The Auth user must already exist. SQL alternative (the row links to `auth.users` when that email already has a login):
  ```sql
  insert into public.users (email, role)
  values ('operator@example.com', 'supervisor')
  on conflict (email) do update set role = excluded.role;
  ```
- [ ] **First admin on a new project** — sign in, then **Settings → Users** lets you provision only your own email as `admin` (bootstrap rule).
- [ ] User signs in; supervisors must not see Staff (unless permitted), Analysis, Reports or Settings.

**Remove a user:** **Settings → Users → delete** (`delete_staff`) removes app access; also delete the Auth user in Supabase so they cannot sign in.

---

## Add a secret

- [ ] Decide where it lives: GitHub environment (CI), Supabase Edge secrets (functions), or `js/env.js` (**public values only** — it ships to browsers).
- [ ] Set it on **staging and prod**.
- [ ] Add a row to [SECRETS.md](SECRETS.md) (stored in / used by / how to rotate).
- [ ] Never commit it; `git diff --cached` before every commit.
