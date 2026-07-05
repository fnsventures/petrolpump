# Development guide

This document covers **local development**, **deployment** (prod and staging), and **supervisor/operator login** for Bishnupriya Fuels (Petrol Pump). For project structure and tech stack, see [Architecture](ARCHITECTURE.md).

---

## 1. Local development

### 1.1 Prerequisites

- A Supabase project (create one at [supabase.com](https://supabase.com)).
- A local HTTP server (e.g. Python 3 or Node) to serve static files and avoid CORS issues.

### 1.2 Configure Supabase credentials

The app reads configuration from `js/env.js`, which is **gitignored** to avoid committing secrets.

1. Copy the example file:

   ```bash
   cp js/env.example.js js/env.js
   ```

2. Edit `js/env.js` and set your Supabase project values:

   ```javascript
   window.__APP_CONFIG__ = {
     SUPABASE_URL: "https://your-project-id.supabase.co",
     SUPABASE_ANON_KEY: "your-anon-key-here",
     APP_ENV: "development",
   };
   ```

   You can find **Project URL** and **anon key** in the Supabase dashboard under **Project Settings → API**.

3. Apply the schema (if not already done) by running the SQL in `supabase/schema.sql` in the Supabase SQL Editor, or apply migrations **in filename order** from `supabase/migrations/`. After a fresh apply, `pump_settings` row `id = 1` is created with empty `{}` config; open **Settings** as admin to seed station/billing defaults (or rely on `js/appConfig.js` client fallbacks until saved).

   **Storage buckets** for profile and staff photos (`user-avatars`, `staff-photos`) are created by migrations `20260528300000_user_avatar.sql` and `20260528500000_employee_photo.sql`. If you applied schema manually without migrations, run those migrations too.

4. **Service worker (optional):** The app registers `sw.js` for offline caching. During local dev, hard-refresh or unregister the worker if assets look stale after changes. Bump `CACHE_VERSION` in `sw.js` when shipping static asset updates.

### 1.3 Run a local server

Serve the project from the repository root so that paths like `/js/env.js` and `/css/app.css` resolve correctly.

**Using Python 3:**

```bash
python3 -m http.server 3000
```

**Using Node (npx):**

```bash
npx serve -p 3000
```

Then open **http://localhost:3000/** in your browser. Use `index.html` or `login.html` as the entry point.

### 1.4 First login

Two steps are required — Supabase Auth alone is **not** enough to use the app:

1. **Supabase Auth** — Create the user under **Authentication → Users** (email/password).
2. **Provision in `public.users`** — Add a row with the same email and role `admin` or `supervisor`.

**Greenfield (no admin yet):** After signing in, the first user can self-provision as admin via **Settings → Users** or the `upsert_staff` RPC. Bootstrap rules enforce: only **your own JWT email**, role must be **`admin`**. You cannot create a supervisor or provision someone else's email until an admin exists.

**Existing deployment:** An admin adds operators via **Settings → Users** or SQL:

```sql
insert into public.users (email, role)
values ('your@email.com', 'admin')
on conflict (email) do update set role = 'admin';
```

**Unprovisioned users** (Auth account only, no `public.users` row) can sign in but will see empty data and errors on all operational pages — RLS and RPCs require provisioned staff (`is_supervisor_or_admin()`).

---

## 2. Deployment (prod and staging)

The repository uses **GitHub Actions** to deploy two environments to **GitHub Pages**.

| Environment | Branch   | Typical URL |
|-------------|----------|-------------|
| **Production** | `main`   | Root (e.g. `https://bishnupriyafuels.fnsventures.in/`) |
| **Staging**    | `staging` | `/staging/` (e.g. `https://bishnupriyafuels.fnsventures.in/staging/`) |

### 2.1 How it works

Only **`.github/workflows/deploy-pages.yml`** is needed for frontend deploy. **`merge.yml` is not used** (removed — push events trigger deploy directly).

| Trigger | What happens |
|---------|----------------|
| Push to **`staging`** | Auto-deploy that commit to **staging** (`/staging/`) |
| Push to **`main`** | Auto-deploy that commit to **prod** (root) |
| **Manual** (Actions → Deploy → Run workflow) | Deploy any branch/tag/commit to **staging** or **prod** |

Manual deploy steps:
1. Actions → **Deploy** → **Run workflow**
2. **Use workflow from** — pick the branch that contains the code (e.g. `feature/my-change` or `staging`)
3. **target** — `staging` or `prod`
4. **ref** *(optional)* — override with a specific branch, tag, or commit SHA; leave empty to use the branch from step 2

Each deploy uses that environment’s GitHub secrets and pushes to **`gh-pages`** (staging → `/staging/` only; prod → root, staging preserved).

### 2.2 Required GitHub configuration

1. **GitHub Pages source:** Settings → Pages → Build and deployment → **Deploy from a branch** → Branch **`gh-pages`** → **`/ (root)`**.
2. Create two **environments** in the repo: **prod** and **staging** (Settings → Environments).
3. In each environment, add **Environment secrets**:
   - `SUPABASE_URL` — Supabase project URL for that environment.
   - `SUPABASE_ANON_KEY` — Supabase anon (public) key for that environment.

   **Prod only** — for the monthly database backup workflow (full guide: [Backup](BACKUP.md)):
   - `PROD_DB_URL` — Session pooler URI from Supabase → Connect.
   - `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` — same values as Supabase Edge Function secrets (invoice documents).
   - `GOOGLE_DRIVE_BACKUP_FOLDER_ID` — Google Drive folder ID for DB backups (create a dedicated folder; not the invoice root).

Use one Supabase project for prod and another for staging.

### 2.3 Deploy flow

1. **Test in staging**  
   Merge a PR into `staging`, or run **Deploy** manually with target `staging` from your feature branch.

2. **Promote to production**  
   Merge `staging` into `main`, or run **Deploy** manually with target `prod` (typically from `main` or `staging`).

### 2.4 Database scripts (sync, migrate, backup)

Maintenance scripts live in **`scripts/`**. Full guide: **[scripts/README.md](../scripts/README.md)**.

**Setup once:**

```bash
cp scripts/db.env.example scripts/db.env
# PROD_DB_URL + STAGING_DB_URL from Supabase → Connect → Session pooler
```

**Release order:**

| Step | Command | Prod | Staging |
|------|---------|------|---------|
| 1. Copy real data for testing | `./scripts/db.sh sync` | read only | replaced |
| 2. Test app | push `staging` branch → `/staging/` | — | — |
| 3. Preflight prod migration | `./scripts/db.sh migrate` | no changes | — |
| 4. Migrate prod schema | `./scripts/db.sh migrate --apply` | schema upgraded | — |
| 5. Deploy app | merge `staging` → `main` | site updated | — |

Optional: `./scripts/db.sh backup` before step 4.

### 2.5 Edge functions (manual deploy)

GitHub Actions deploys the **static frontend only**. Supabase Edge Functions must be deployed separately with the Supabase CLI.

**Prerequisite:** [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in.

```bash
supabase login
supabase functions deploy invoice-documents --project-ref YOUR_PROJECT_REF
```

Repeat for **staging** and **prod** Supabase projects (each has its own project ref in **Project Settings → General**).

**Secrets:** Google OAuth and other function secrets are set in Supabase Dashboard → **Edge Functions → Secrets**, not in GitHub. Full walkthrough: [Invoice documents guide](INVOICE_DOCUMENTS.md).

| Function | Purpose |
|----------|---------|
| `invoice-documents` | Upload/download/delete supplier invoices in Google Drive |
| `get-dashboard-data` | Optional batched dashboard payload |

When releasing invoice-document changes, deploy the function **before or with** the frontend merge. See [Invoice documents → Release checklist](INVOICE_DOCUMENTS.md#10-release-checklist).

---

## 3. Supervisor / operator login

Operators can log in with a **supervisor** role: they see operational pages (dashboard, DSR, credit, expenses, day closing, **billing**, **invoice documents**, attendance, salary) but **not** Staff roster, Analysis, **Reports**, or Settings. They cannot edit the employee roster, product catalog, or station config (admin-only RLS). They **can** record attendance, salary payments, and supplier invoice uploads. Both roles must be **provisioned** in `public.users` — an Auth account alone is insufficient. Data access is enforced by RLS and RPC guards; see [Architecture → Security model](ARCHITECTURE.md#7-security-model).

### 3.1 Steps to enable a supervisor

1. **Supabase Auth**  
   Ensure the user exists under **Authentication → Users**. Create the user (or have them sign up) and set a password.

2. **App users table**  
   Add a row in `public.users` with role `supervisor`:
   - From the app: an **admin** can add them via **Settings**.
   - From Supabase SQL Editor:

     ```sql
     insert into public.users (email, role)
     values ('operator@example.com', 'supervisor')
     on conflict (email) do update set role = 'supervisor';
     ```

   Emails are stored in lowercase; the app matches login email case-insensitively.

3. **Login**  
   The user signs in on the login page with the same email and password. They are redirected to the dashboard; Staff, Analysis, Reports, and Settings are hidden from the navigation. Direct navigation to admin URLs is blocked by `check_page_access` when pages use `requireAuth({ pageName: … })`.

4. **Profile (optional)**  
   Supervisors can upload a profile avatar from the topbar user menu (same as admins).

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | Project structure, tech stack, security, deployment overview |
| [Data Tables](DATA_TABLES.md) | Database tables and RLS |
| [Flows](FLOWS.md) | User and data flows |
| [Invoice documents](INVOICE_DOCUMENTS.md) | Google Drive setup, edge function deploy, troubleshooting |
| [Backup](BACKUP.md) | Prod DB backup to Google Drive (GitHub Actions, restore, troubleshooting) |
