# Operations playbook

Simple steps for everyday engineering work: **sync staging**, **deploy**, **release**, and **backup**.

Read this page when you need to **do** something.  
For animated diagrams of the same flows, see the [root README → Visual tour](../README.md#visual-tour).

---

## Before you start (one-time)

### What exists

| Name | Meaning |
|------|---------|
| **Production** | Live station app + live database. Branch: `main`. |
| **Staging** | Test copy of the app + separate test database. Branch: `staging`. URL ends with `/staging/`. |
| **Frontend** | HTML/JS pages on GitHub Pages. |
| **Database** | Supabase Postgres (prod and staging are **two different** projects). |

Important:

- Pushing code **does not** copy the database.
- Syncing the database **does not** deploy the website.
- You do these as separate steps.

### One-time setup on your laptop

1. Install tools: Node.js, [Supabase CLI](https://supabase.com/docs/guides/cli), Docker Desktop (or `libpq`).
2. Create DB credentials file:

```bash
cp scripts/db.env.example scripts/db.env
```

3. Open `scripts/db.env` and paste **Session pooler** URLs (port **5432**) from each Supabase project → **Connect**:

```bash
PROD_DB_URL="postgresql://..."
STAGING_DB_URL="postgresql://..."
```

Encode special characters in the password (`@` → `%40`).

4. Confirm GitHub environments **staging** and **prod** each have:

| Secret | Needed for |
|--------|------------|
| `SUPABASE_URL` | Website deploy |
| `SUPABASE_ANON_KEY` | Website deploy |

That is enough for sync + deploy + release. Backup needs extra secrets (see [§4](#4-backup-production-database)).

### DNS safety net (`fnsventures.in`)

Several apps share the same DNS zone. **Adding a new subdomain must never remove another app’s CNAME.** A missing host can look like a config error because cached HTML may still load while `/js/env.js` (never cached) fails. The UI now distinguishes **unreachable config (DNS/network)** from a truly missing/invalid `env.js`.

| Host (CNAME) | Target | App / repo |
|--------------|--------|------------|
| `bishnupriyafuels` | `fnsventures.github.io` | This app (`petrolpump`) |
| `fnscashline` | `fnsventures.github.io` | FiNDi ATM (`fns-cashline`) |

**Registrar (GoDaddy):**

- [ ] Account has **2FA** enabled
- [ ] Domain change / security **alerts** enabled for the account email
- [ ] Before editing DNS: screenshot or export the DNS table
- [ ] After editing: **add** a new row only — do not overwrite sibling hosts
- [ ] **API auto-fix secrets** (once): create a Production key at [developer.godaddy.com/keys](https://developer.godaddy.com/keys), then add **repository secrets** on `petrolpump` (required for the hourly job). Optional on `fns-cashline` for manual runs:
  - `GODADDY_API_KEY`
  - `GODADDY_API_SECRET`

**After any DNS change**, verify every sibling (not only the app you just touched):

```bash
./scripts/check-dns-siblings.sh           # check only
./scripts/check-dns-siblings.sh --fix     # restore missing/wrong CNAMEs via GoDaddy, then recheck
```

Or open each URL and confirm a real config (not placeholders):

- `https://bishnupriyafuels.fnsventures.in/js/env.js`
- `https://fnscashline.fnsventures.in/js/env.js`

**Automated (single schedule):** This repo’s **Check DNS siblings** Action runs **hourly** (+ manual) and calls the shared reusable workflow / canonical `scripts/check-dns-siblings.sh`. `fns-cashline` has **manual only** (no second cron) and reuses the same workflow from this repo.

If a CNAME is missing or wrong, the job **rewrites** it to `fnsventures.github.io` via GoDaddy, waits up to ~12 minutes for publish/negative cache, rechecks, writes a job summary, and **opens a GitHub issue** when it actually restored records. Without `GODADDY_*` secrets it still checks and fails.

Auto-fix covers **DNS only**. If `/js/env.js` is wrong after DNS is healthy, redeploy that app (Actions → **Deploy** → `prod`) so CI regenerates `env.js`.

When you add a new `*.fnsventures.in` Pages app, append its host to **this** repo’s `scripts/check-dns-siblings.sh` only (cashline wraps that file) and document it in OPERATIONS.md.

---

## 1. Sync staging with production data

**What it does:** Copies **data** from the live database into the staging database so you can test with real numbers.

**What it does not do:** Change production. Deploy the website. Apply new schema.

| | Production | Staging |
|--|------------|---------|
| Data | Read only | **Fully replaced** |
| Website | Unchanged | Unchanged |

### Steps

1. Make sure Docker is running (if you use it for dumps).
2. Run:

```bash
./scripts/db.sh sync
```

3. Wait until it finishes without errors.
4. Open the **staging website** and log in. You should see production-like data.

If sync fails with connection errors, your `scripts/db.env` URLs are wrong — use Session pooler, not Direct.

---

## 2. Deploy the website to staging

**What it does:** Publishes the frontend to `/staging/` so you can click through changes.

**What it does not do:** Change the production website. Change any database.

### Steps

1. Merge your work into the `staging` branch (or push to `staging`).
2. Wait for GitHub Actions → **Deploy** to finish (about 1–2 minutes).
3. Open `https://YOUR-SITE/staging/` and test.

**Manual option:** Actions → **Deploy** → Run workflow → target `staging`.

---

## 3. Release to production

Do the steps **in order**. Do not skip.

### Picture

```
Code on staging  →  test on /staging/
        ↓
Database migrate (only if schema changed)
        ↓
Merge staging → main  →  live website
```

### Step A — Put real data on staging (recommended)

```bash
./scripts/db.sh sync
```

Then open `/staging/` and confirm the app works with that data.

### Step B — Put your code on staging

Merge or push to `staging`. Wait for Deploy. Test again on `/staging/`.

### Step C — Database changes? (only if you added migrations)

If this release has **no** new files under `supabase/migrations/`, skip to Step D.

If it **does** have migrations:

1. Review safely (no production change):

```bash
./scripts/db.sh migrate
```

2. When the pump is quiet (no one entering DSR / day closing), apply:

```bash
./scripts/db.sh migrate --apply
```

This automatically takes a **local** backup first, then upgrades the **production** schema.

### Step D — Go live (frontend)

1. Merge `staging` → `main`.
2. Wait for GitHub Actions → **Deploy**.
3. Open the live site. Smoke-test: login → dashboard → one real page (e.g. Meter Reading).

### Short checklist

- [ ] Sync (optional but recommended)
- [ ] Code on `staging` and tested
- [ ] Migrations applied **if any** (`migrate` then `migrate --apply`)
- [ ] Merge to `main`
- [ ] Live site checked

---

## 4. Backup production database

**What it does:** Saves a full copy of the production database (schema + data). Safe for production — **read only**.

**What it does not do:** Change data. Deploy the website.

### Option A — Google Drive (recommended)

Monthly automation runs on the 1st of each month. You can also run it anytime.

**Run now**

1. GitHub → **Actions** → **Backup production database** → **Run workflow**.
2. Wait for a green check.
3. Open Google Drive → your backup folder → `YYYY/YYYY-MM/`.

You should see files like:

- `prod-schema-….sql.gz`
- `prod-data-….sql.gz`
- `backup-manifest-….txt`

**One-time secrets** (GitHub → Settings → Environments → **prod**):

| Secret | Purpose |
|--------|---------|
| `PROD_DB_URL` | Read production database |
| `GOOGLE_OAUTH_CLIENT_ID` | Drive upload |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Drive upload |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Drive upload |
| `GOOGLE_DRIVE_BACKUP_FOLDER_ID` | Target Drive folder ID |

OAuth setup (once): [Invoice documents — Google OAuth](INVOICE_DOCUMENTS.md#34-create-oauth-client-credentials)  
Use the same three OAuth values for invoices and backup.  
Folder ID: open the Drive folder → copy the ID from the URL after `/folders/`.

If the job fails with `unauthorized_client`, the refresh token does not match the client ID/secret. Regenerate all three together (Playground must use **Use your own OAuth credentials**), update the secrets, then re-run.

### Option B — Local file only

```bash
./scripts/db.sh backup
```

Files go to `scripts/.prod-backups/` (not uploaded to Drive). Use before a risky change when you are at your laptop.

### Option C — Local + Drive from laptop

After Google secrets are set in your shell:

```bash
export GOOGLE_OAUTH_CLIENT_ID="..."
export GOOGLE_OAUTH_CLIENT_SECRET="..."
export GOOGLE_OAUTH_REFRESH_TOKEN="..."
export GOOGLE_DRIVE_BACKUP_FOLDER_ID="..."
./scripts/backup-prod-to-drive.sh
```

(`PROD_DB_URL` comes from `scripts/db.env`.)

---

## 5. Which command should I run?

| I want to… | Do this |
|------------|---------|
| Test with live data on staging | `./scripts/db.sh sync` |
| Publish test website | Push / merge to `staging` |
| See pending DB migrations (safe) | `./scripts/db.sh migrate` |
| Upgrade live database schema | `./scripts/db.sh migrate --apply` |
| Publish live website | Merge `staging` → `main` |
| Save DB to my laptop | `./scripts/db.sh backup` |
| Save DB to Google Drive | Actions → **Backup production database** |
| After DNS edits / check sibling sites | `./scripts/check-dns-siblings.sh` |
| Restore missing sibling CNAMEs | `./scripts/check-dns-siblings.sh --fix` (needs `GODADDY_*`) |

---

## 6. Common problems

| Problem | Fix |
|---------|-----|
| Sync / migrate cannot connect | Use **Session pooler** URL in `scripts/db.env`, not Direct |
| Staging website shows wrong project | GitHub **staging** secrets `SUPABASE_URL` / `SUPABASE_ANON_KEY` |
| Live site unchanged after merge | Wait for Actions **Deploy**; hard-refresh (service worker) |
| Drive backup: `unauthorized_client` | Regenerate matching OAuth trio; update GitHub **prod** secrets |
| Login works but empty pages | User missing from `public.users` |
| Banner: cannot reach `js/env.js` / DNS | Restore CNAME → `fnsventures.github.io` (`./scripts/check-dns-siblings.sh --fix` or wait for hourly Action). Hard-refresh after DNS recovers |
| Banner: config missing / copy `env.example.js` | Real missing/invalid env. Local: copy `env.example.js`. Prod: Redeploy so CI regenerates `env.js` |

---

## More detail (only if needed)

| Topic | Document |
|-------|----------|
| Local app setup, supervisors, edge functions | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Script internals and error messages | [scripts/README.md](../scripts/README.md) |
| Drive backup restore and architecture | [BACKUP.md](BACKUP.md) |
| Supplier invoice PDFs | [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
