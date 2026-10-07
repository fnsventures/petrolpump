# Database migrations

How to change the schema safely without guessing.

**Day-to-day apply steps:** [staging schema only](OPERATIONS.md#apply-migrations-to-staging-only) · [production](OPERATIONS.md#3-release-to-production)  
**Script internals / errors:** [scripts/README.md](../scripts/README.md)

---

## Source of truth

| Artifact | Role |
|----------|------|
| `supabase/migrations/*.sql` | **Incremental changes** — what CI/scripts apply with `supabase db push` |
| `supabase/schema.sql` | **Full snapshot** for greenfield installs and human reading |

**Ongoing work always adds a migration file.** After a meaningful schema change, update `supabase/schema.sql` (and [DATA_TABLES.md](DATA_TABLES.md) if tables/RPCs/RLS changed) so a new project from `schema.sql` stays aligned with migrations.

Do **not** edit an already-applied migration on prod. Add a new timestamped file instead.

---

## Naming

```
supabase/migrations/YYYYMMDDHHMMSS_short_snake_description.sql
```

Create files with the CLI so the timestamp is **now** (UTC):

```bash
supabase migration new short_snake_description
```

**Rule:** a new migration must sort **after every existing file**. `supabase db push` refuses to run a local file whose version is older than the latest version already applied on the remote (`Found local migration files to be inserted before the last migration on remote`). The PR check `scripts/check-migration-order.sh` enforces this.

**Known exception — do not rename:** `20250602100000_credit_customer_contact.sql`, `20250602120000_salary_slip_pf.sql`, `20250602130000_employee_pf_contribution.sql` were committed on 2026-06-02 (year typo) and sort before `20260528*`. They are already recorded in prod/staging `supabase_migrations.schema_migrations`; renaming them would make the CLI treat them as new and re-run them. On a fresh database they apply in filename order without error. If any database applied `20260528*` *before* these three existed, push once with:

```bash
supabase db push --db-url "$DB_URL" --include-all --dry-run   # review
supabase db push --db-url "$DB_URL" --include-all
```

---

## Author a change

1. Branch from `staging`.
2. `supabase migration new <name>` — one focused SQL file.
   - Redefining an existing function? Copy the **latest** definition: `grep -lE "create( or replace)? function public\.<name>\b" supabase/migrations/* | sort | tail -1`. A pattern of `function public.<name>` also matches `grant` and `comment on function`.
3. Prefer additive, safe changes:
   - New columns nullable or with defaults
   - New RPCs / views / indexes
   - RLS policy updates that do not lock out admins
4. Avoid destructive drops on prod data unless you have an explicit restore plan and a quiet window.
5. Update `supabase/schema.sql` and check with `./scripts/check-schema-drift.sh`.
6. Update docs if the public model changed: [DATA_TABLES.md](DATA_TABLES.md) / [DSR_TABLES.md](DSR_TABLES.md); day-closing RPCs → [DAY_CLOSING.md](DAY_CLOSING.md).
7. Test on staging (below), then ship via Operations release order.

---

## Apply order (staging → prod)

Apply on **staging** and smoke-test `/staging/` before any production migrate. `./scripts/db.sh migrate` and `./scripts/db.sh migrate --apply` change **production** only.

### Staging schema only

Pushes pending files in `supabase/migrations/` to the staging project. Existing staging rows stay. Production is not contacted.

Needs the Supabase CLI and `STAGING_DB_URL` (Session pooler) in `scripts/db.env`. From the repo root:

```bash
set -a
source scripts/db.env
set +a

# Lists pending files. Changes nothing.
supabase db push --db-url "$STAGING_DB_URL" --dry-run

# Applies those files to staging only.
supabase db push --db-url "$STAGING_DB_URL" --yes
```

Stop if the dry-run lists migrations older than the latest version already on staging, or says a local file would be inserted before the last remote migration (`Found local migration files to be inserted before the last migration on remote`).

`scripts/stamp-staging-migrations.sql` only marks the old bootstrap history as applied (`on conflict do nothing`). It does not run SQL. `./scripts/db.sh sync` runs it; a staging database that already has migration history does not need it for new files. **Never** run that stamp file on production.

Then smoke-test `/staging/`: login → dashboard → the page that uses the new object.

### Staging with production data

`./scripts/db.sh sync` runs that same staging schema push, then **replaces staging data** with a production dump. Use it when you want real DSR, credit, and HR numbers. Use the schema-only commands above when you want the new SQL and the current staging rows.

### Production (release)

```bash
# 1) Safe — no prod change
./scripts/db.sh migrate

# 2) Quiet window — backup then apply
./scripts/db.sh migrate --apply
```

Then merge frontend `staging` → `main` if the UI depends on the new schema ([OPERATIONS.md](OPERATIONS.md)).

**Never** run `stamp-staging-migrations.sql` on production.

---

## Greenfield database

Run **`supabase/schema.sql`** on the new project (SQL Editor or `psql -v ON_ERROR_STOP=1 -f supabase/schema.sql`). It is the only file that builds a database from empty, including Storage buckets and policies. `scripts/check-schema-drift.sh` keeps it equal to the migrations.

**Do not** `supabase db push` onto an empty project: the oldest migrations are patches on top of the pre-migrations schema (commit `5383acd`), so the first file fails on a bare database. After loading `schema.sql`, mark every migration as applied so future pushes only run new files:

```bash
supabase migration repair --db-url "$NEW_DB_URL" --status applied $(ls supabase/migrations | cut -c1-14)
```

Then create the first admin ([CHECKLISTS.md → Add a user](CHECKLISTS.md#add-a-user)). Restoring from a backup instead: [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md).

---

## Keeping `schema.sql` in sync

Every PR that adds a migration must also update `supabase/schema.sql`. Check locally (needs Docker, ~15 s):

```bash
./scripts/check-schema-drift.sh            # 0 = in sync, 1 = drift (prints diff), 2 = a SQL file failed
KEEP_DRIFT_CONTAINERS=1 ./scripts/check-schema-drift.sh   # leave both DBs up to inspect
```

It builds DB A from the `5383acd` baseline + every migration in filename order, DB B from `schema.sql`, and diffs normalized schema dumps. CI runs it on PRs that touch `supabase/`.

**Stale overloads:** when a migration changes a function's signature, `drop function if exists` the old signature in the same file — `create or replace` with new arguments adds an overload and leaves the old one callable. `20261006054630_money_write_integrity.sql` dropped the four that had accumulated (`add_credit_entry` 7-arg, `record_credit_payment(uuid,date,numeric,text)`, `save_day_closing(date,numeric,numeric)`, `upsert_staff(text,text)`). `LEGACY_OVERLOADS` in the drift script is now empty; only add to it as a stopgap.

---

## Rollback

There are no down-migrations. Prefer a **forward fix** (new migration). For an inverse-migration template, `migration repair`, and restoring the automatic pre-migrate backup, see [DISASTER_RECOVERY.md → Schema rollback](DISASTER_RECOVERY.md#schema-rollback).

---

## Verify after apply

```bash
# Example: batch credit RPC
# Run in Supabase SQL Editor:
# scripts/verify-batch-rpc.sql
```

Smoke-test on staging/prod: login → dashboard → the page that uses the new object.

---

## Common mistakes

| Mistake | Result |
|---------|--------|
| Only edit `schema.sql`, no migration | Prod never gets the change via `db push` |
| Apply migration on prod before testing on staging | Harder rollback |
| `./scripts/db.sh migrate --apply` when you meant staging | Production schema changes |
| `./scripts/db.sh sync` when you only wanted the new SQL | Staging data replaced with prod |
| Use Direct DB URL in `db.env` | Connection failures — [use Session pooler](SECRETS.md#a-laptop-gitignored) |
| Commit `scripts/db.env` | Credential leak |
| Run stamp-staging SQL on prod | Migrations marked applied without running |

---

## Related commands

| Command | Effect |
|---------|--------|
| `supabase db push --db-url "$STAGING_DB_URL" --dry-run` | List pending migrations on staging |
| `supabase db push --db-url "$STAGING_DB_URL" --yes` | Apply pending migrations on staging; data kept |
| `./scripts/db.sh sync` | Staging schema, then replace staging data from prod |
| `./scripts/db.sh migrate` | Preflight / dry-run on prod |
| `./scripts/db.sh migrate --apply` | Backup + push migrations to prod |
| `./scripts/db.sh backup` | Local prod dump only |
