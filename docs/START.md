# Start

Get a laptop to the point where you can run Bishnupriya Fuels, sign in, and tell the website apart from the database.

Day-to-day shipping is [OPERATIONS.md](OPERATIONS.md). Credentials are [SECRETS.md](SECRETS.md). When something fails, [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Access

| System | Why |
|--------|-----|
| GitHub `fnsventures/petrolpump` | Code, pull requests, Actions, environments |
| Supabase **prod** and **staging** | Auth, database, Storage, Edge Functions. Two separate projects |
| Google Drive backup folder | Monthly database dumps |
| Google Cloud OAuth | Invoice PDFs and Drive backup. Same client — [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| GoDaddy | DNS for `*.fnsventures.in`, only if you edit records |

Code owners for critical paths are in `.github/CODEOWNERS`.

## Laptop

1. Install **Node.js 22** (`.nvmrc`), the [Supabase CLI](https://supabase.com/docs/guides/cli), and either Docker Desktop or `libpq` (`brew install supabase/tap/supabase` and `brew install libpq`).
2. Clone and install:

```bash
git clone https://github.com/fnsventures/petrolpump.git
cd petrolpump
npm ci
```

3. Frontend config. The file is gitignored.

```bash
cp js/env.example.js js/env.js
```

```javascript
window.__APP_CONFIG__ = {
  SUPABASE_URL: "https://your-project-id.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key-here",
  APP_ENV: "development",
};
```

Project URL and anon key: Supabase → **Project Settings → API**. Staging is the right project for a laptop. The anon key is public; Row Level Security is what protects data.

4. Database scripts:

```bash
cp scripts/db.env.example scripts/db.env
./scripts/db.sh help
```

`PROD_DB_URL` and `STAGING_DB_URL` are Session pooler URIs. Format: [SECRETS.md → Laptop](SECRETS.md#a-laptop-gitignored).

5. Run the app:

```bash
npm run dev
```

Open **http://localhost:3000/**. `npm run dev` builds `_site/` and expands `<!-- @partial … -->` comments from `_partials/`. Serving the repo root with `python3 -m http.server` leaves those comments unexpanded, so the sidebar and scripts are missing.

Page CSS and scripts are listed in `_partials/app-pages.json`. Do not copy `<script>` tags between HTML files, and do not add `?v=` — content hashes are stamped at build.

If the page looks stale, hard-refresh or unregister the service worker. `js/pwa.js` registers `sw.js`.

## First login

An Auth account alone is not enough. Every operator needs both:

1. **Supabase Auth** — **Authentication → Users → Add user**. Leave **Allow new users to sign up** off on both projects (Authentication → Sign In / Up). The app cannot change that switch.
2. **`public.users`** — same email, role `admin` or `supervisor`.

**No admin yet.** After you sign in, **Settings → Users** (or `upsert_staff`) can provision only your own JWT email, and only as `admin`.

**An admin already exists.** They add people in **Settings → Users**, or:

```sql
insert into public.users (email, role)
values ('your@email.com', 'admin')
on conflict (email) do update set role = excluded.role;
```

Emails are stored in lowercase. The role is resolved from `users.auth_user_id`, not from the email claim in the token. A signed-in user with no `public.users` row is sent to `login.html?error=unprovisioned` and sees empty data everywhere else.

What a supervisor can open is in [ARCHITECTURE.md → Security](ARCHITECTURE.md#7-security-model). The click-path is [CHECKLISTS.md → Add a user](CHECKLISTS.md#add-a-user).

## Empty database

`supabase/schema.sql` is the file that builds a database from empty, including Storage buckets. Do not `supabase db push` onto a bare project. Steps: [MIGRATIONS.md → Greenfield](MIGRATIONS.md#greenfield-database).

After a fresh apply, `pump_settings` row `id = 1` is `{}`. Open **Settings** as admin to seed station and billing defaults. Until then, `js/appConfig.js` supplies client fallbacks.

Profile and staff photo buckets (`user-avatars`, `staff-photos`) come from migrations `20260528300000_user_avatar.sql` and `20260528500000_employee_photo.sql`.

## Two sites, two databases

| | Production | Staging |
|--|------------|---------|
| Git branch | `main` | `staging` |
| Site | `https://bishnupriyafuels.fnsventures.in/` | `…/staging/` |
| Supabase | Prod project | Staging project |
| GitHub environment | `prod` | `staging` |

Pushing code does not copy the database. Syncing the database does not deploy the website.

| Action | Website | Prod data | Prod schema |
|--------|---------|-----------|-------------|
| Push or merge to `staging` | Staging only | Unchanged | Unchanged |
| Merge `staging` → `main` | Production | Unchanged | Unchanged |
| `./scripts/db.sh sync` | Unchanged | Unchanged (staging **data** replaced) | Unchanged |
| `supabase db push` with `STAGING_DB_URL` | Unchanged | Unchanged (staging schema only) | Unchanged |
| `./scripts/db.sh migrate` | Unchanged | Unchanged | Unchanged (dry run) |
| `./scripts/db.sh migrate --apply` | Unchanged | Unchanged | **Changed** |
| Actions → Backup | Unchanged | Unchanged (read-only dump) | Unchanged |

The order for a release is [OPERATIONS.md](OPERATIONS.md).

## Weekly

- Actions: last **Deploy** on `main` and `staging` is green.
- Once a month: Drive has a new `YYYY/YYYY-MM/` dump, or you run the backup workflow.
- Once a quarter: restore drill in [RECOVERY.md](RECOVERY.md#restore-drill), then update its “last tested” line.
- Before a release: smoke-test `/staging/` after a sync.
- Never commit `js/env.js`, `scripts/db.env`, dumps, or OAuth tokens.

## Checks you can run locally

```bash
npm test
npm run build:site
node scripts/check-doc-links.mjs
./scripts/check-migration-order.sh
./scripts/check-schema-drift.sh   # needs Docker
```
