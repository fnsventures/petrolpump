# Operations

Sync staging, deploy, and release. Read this when you need to **do** the step. Backup contents and restore are [RECOVERY.md](RECOVERY.md). Laptop setup is [START.md](START.md).

<a id="dns-safety-net-fnsventuresin"></a>

## Before you start

| Name | Meaning |
|------|---------|
| **Production** | Live station app and live database. Branch `main`. |
| **Staging** | Test copy of the app and a separate database. Branch `staging`. URL ends with `/staging/`. |
| **Frontend** | HTML and JS on GitHub Pages. |
| **Database** | Supabase Postgres. Prod and staging are two projects. |

Pushing code does not copy the database. Syncing the database does not deploy the website.

### Laptop

1. Node.js, the [Supabase CLI](https://supabase.com/docs/guides/cli), and Docker Desktop or `libpq`. Full install: [START.md](START.md).
2. `cp scripts/db.env.example scripts/db.env` and paste **Session pooler** URLs (port **5432**) from each project → **Connect**:

```bash
PROD_DB_URL="postgresql://..."
STAGING_DB_URL="postgresql://..."
```

Format: [SECRETS.md → Laptop](SECRETS.md#a-laptop-gitignored).

3. GitHub environments **staging** and **prod** each need `SUPABASE_URL` and `SUPABASE_ANON_KEY`. That is enough to deploy the website. Backup needs five more secrets — [Recovery → Setup](RECOVERY.md#setup).

**Pages source (once):** Settings → Pages → **Deploy from a branch** → branch `gh-pages` → `/ (root)`.

Only `.github/workflows/deploy-pages.yml` deploys the frontend. A push to `staging` or `main` deploys that commit. **Actions → Deploy → Run workflow** can deploy any ref: pick the branch that contains the code, set **target** to `staging` or `prod`, and optionally set **ref** to a branch, tag, or SHA. Staging writes `/staging/` only. Prod writes the root and leaves `/staging/` in place.

### DNS safety net

Several apps share `fnsventures.in`. Adding a subdomain must never remove another app’s CNAME. A missing host looks like a config error: cached HTML can still load while `/js/env.js` (never cached) fails. The UI separates **unreachable config** from a missing or invalid `env.js`.

| Host (CNAME) | Target | App |
|--------------|--------|-----|
| `bishnupriyafuels` | `fnsventures.github.io` | This app (`petrolpump`) |
| `fnscashline` | `fnsventures.github.io` | FiNDi ATM (`fns-cashline`) |

At the registrar (GoDaddy):

- Account has 2FA, and domain-change alerts go to the account email.
- Before an edit, screenshot or export the DNS table. After the edit, add a row. Do not overwrite a sibling host.
- Optional auto-fix: a Production key from [developer.godaddy.com/keys](https://developer.godaddy.com/keys), then repository secrets `GODADDY_API_KEY` and `GODADDY_API_SECRET` on `petrolpump` (required for the hourly job). Optional on `fns-cashline` for manual runs.

After any DNS change, check every sibling:

```bash
./scripts/check-dns-siblings.sh           # check only
./scripts/check-dns-siblings.sh --fix     # restore missing or wrong CNAMEs, then recheck
```

Or open both configs and confirm they are real, not placeholders:

- `https://bishnupriyafuels.fnsventures.in/js/env.js`
- `https://fnscashline.fnsventures.in/js/env.js`

**Check DNS siblings** runs hourly from this repo and calls `scripts/check-dns-siblings.sh`. `fns-cashline` is manual only and reuses the same workflow. If a CNAME is missing or wrong, the job rewrites it to `fnsventures.github.io`, waits up to about 12 minutes, rechecks, and opens a GitHub issue when it restored records. Without `GODADDY_*` it still checks and fails.

Auto-fix covers DNS only. If `/js/env.js` is wrong after DNS is healthy, redeploy that app (Actions → **Deploy** → `prod`) so CI regenerates `env.js`.

A new `*.fnsventures.in` Pages app is added to **this** repo’s `scripts/check-dns-siblings.sh` only (cashline wraps that file), and to the table above.

<a id="1-sync-staging-with-production-data"></a>

## Sync staging with production data

Copies **data** from the live database into staging so you can test with real numbers. Before the copy, it applies pending migrations on staging.

It does not change production, deploy the website, or keep the staging rows you already have. Storage file bytes (photos) are not copied.

To apply SQL on staging and **keep** its rows, use [Staging schema](#apply-migrations-to-staging-only).

| | Production | Staging |
|--|------------|---------|
| Data | Read only | Fully replaced |
| Website | Unchanged | Unchanged |

```bash
./scripts/db.sh sync
```

Docker must be running if you use it for dumps. When it finishes, open the staging site and log in. You should see production-like data.

What the script does internally: [scripts/README.md](../scripts/README.md). Connection errors: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

<a id="apply-migrations-to-staging-only"></a>

## Staging schema only

Runs pending files in `supabase/migrations/` on the **staging** database. Staging rows stay. Production is not contacted. The website is not deployed.

`./scripts/db.sh migrate` and `./scripts/db.sh migrate --apply` are production. Do not use them here.

```bash
set -a
source scripts/db.env
set +a
supabase db push --db-url "$STAGING_DB_URL" --dry-run
supabase db push --db-url "$STAGING_DB_URL" --yes
```

Stop if the dry-run lists migrations older than the latest version already on staging, or says a local file would be inserted before the last remote migration. The stamp file and the `20250602*` exception are in [MIGRATIONS.md](MIGRATIONS.md#staging-schema-only).

Then smoke-test `/staging/`: login → dashboard → the page that uses the change.

## Deploy the website to staging

Publishes the frontend to `/staging/`. It does not change the production website or any database.

1. Merge or push to `staging`.
2. Wait for Actions → **Deploy** (about 1–2 minutes).
3. Open `https://bishnupriyafuels.fnsventures.in/staging/` and test.

Manual: Actions → **Deploy** → Run workflow → target `staging`.

<a id="3-release-to-production"></a>

## Release to production

Do these in order.

```
Code on staging  →  test on /staging/
        ↓
Database migrate (only if schema changed)
        ↓
Merge staging → main  →  live website
```

**A. Real data on staging (recommended).** `./scripts/db.sh sync`, then confirm `/staging/` works with that data.

**B. Code on staging.** Merge or push to `staging`. Wait for Deploy. Test `/staging/` again.

**C. Database, only if `supabase/migrations/` has new files.** Apply them on staging first ([Staging schema](#apply-migrations-to-staging-only)) and test. A fresh sync already pushes schema before it replaces staging data.

Then, when the pump is quiet (nobody entering DSR or day closing):

```bash
./scripts/db.sh migrate           # review. No production change
./scripts/db.sh migrate --apply   # local backup, then production schema
```

**D. Go live.** Merge `staging` → `main`. Wait for **Deploy**. Smoke-test the live site: login → dashboard → one real page (Meter Reading).

- [ ] Sync (optional)
- [ ] Staging schema applied if there are new migrations
- [ ] Code on `staging` and tested
- [ ] `migrate` then `migrate --apply` if any migrations
- [ ] Merged to `main`
- [ ] Live site checked

<a id="4-backup-production-database"></a>

## Backup

A backup is a read-only copy of production. It does not change data or deploy the website. What is inside the files, how to set Drive up, and how to restore: [RECOVERY.md](RECOVERY.md).

| I want… | Do this |
|---------|---------|
| Last month on Drive | Actions → **Backup production database** → Run workflow, mode **month**. The scheduled run does this every 1st |
| A chosen month from this laptop | `ARCHIVE_MONTH=2026-10 ./scripts/backup-month-to-drive.sh` |
| A complete copy on this laptop | `./scripts/db.sh backup` → `scripts/.prod-backups/` |
| A complete copy on Drive | `./scripts/backup-prod-to-drive.sh` → Drive `Manual/<timestamp>/` |
| Close a finished year | `YEAR=2026 ./scripts/backup-year-to-drive.sh`, or Actions mode **year-end**. Full copy in `Yearly/2026/`, then that year’s month folders go to trash |
| See which audit rows a purge would delete | `./scripts/purge-audit-log.sh` |
| Delete audit rows older than 6 months | `CONFIRM_PURGE_AUDIT=yes ./scripts/purge-audit-log.sh` |
| Stop audit on staging and empty it | `CONFIRM_STAGING_AUDIT=yes ./scripts/disable-staging-audit.sh` |

The scheduled run uploads the finished month, then deletes production audit rows older than 6 months. On 1 January it also writes `Yearly/<previous year>/` and, only after that upload succeeds, trashes that year’s month folders. The procedure, the file list, and a folder example: [STORAGE_RETENTION.md](STORAGE_RETENTION.md).

`migrate --apply` writes a local backup before it changes schema. It does not upload to Drive.

Free-tier size, indexes, and archiving old years: [STORAGE_RETENTION.md](STORAGE_RETENTION.md). Back up before any archive or index drop.

## Which command

| I want to… | Do this |
|------------|---------|
| Test with live data on staging | `./scripts/db.sh sync` |
| Publish the test website | Push or merge to `staging` |
| See pending production migrations | `./scripts/db.sh migrate` |
| Upgrade the live schema | `./scripts/db.sh migrate --apply` |
| Publish the live website | Merge `staging` → `main` |
| Save the database to this laptop | `./scripts/db.sh backup` |
| Save the finished month to Drive | Actions → **Backup production database**, mode month |
| Save the whole database to Drive | `./scripts/backup-prod-to-drive.sh` |
| Close a calendar year on Drive | `YEAR=2026 ./scripts/backup-year-to-drive.sh` |
| Check sibling DNS | `./scripts/check-dns-siblings.sh` |
| Restore a missing CNAME | `./scripts/check-dns-siblings.sh --fix` |

Failures: [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Restore and schema rollback: [RECOVERY.md](RECOVERY.md).
