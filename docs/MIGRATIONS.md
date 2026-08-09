# Database migrations

How to change the schema safely without guessing.

**Day-to-day apply steps:** [OPERATIONS.md §3 Step C](OPERATIONS.md#3-release-to-production)  
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

Examples already in the repo: `20260708120000_batch_credit_settle_rpc.sql`.

Use UTC-ish ordering; filenames must sort correctly — later change = later timestamp.

---

## Author a change

1. Branch from `staging`.
2. Add one focused SQL file under `supabase/migrations/`.
3. Prefer additive, safe changes:
   - New columns nullable or with defaults
   - New RPCs / views / indexes
   - RLS policy updates that do not lock out admins
4. Avoid destructive drops on prod data unless you have an explicit restore plan and a quiet window.
5. Update docs if the public model changed:
   - [DATA_TABLES.md](DATA_TABLES.md) / [DSR_TABLES.md](DSR_TABLES.md)
   - `supabase/schema.sql` (keep greenfield in sync)
6. Test on staging (below), then ship via Operations release order.

---

## Apply order (staging → prod)

### Staging (usual path)

`./scripts/db.sh sync` stamps pending migrations and pushes schema to staging **before** loading prod data. So after sync, staging schema matches the repo.

You can also push to the staging project with Supabase CLI if you are iterating on schema only (see CLI docs); day-to-day this repo uses `db.sh sync` / `migrate`.

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

Either:

1. Run all of `supabase/schema.sql` in the SQL Editor, **or**
2. Apply every file in `supabase/migrations/` in filename order.

Then create Auth user + `public.users` row ([DEVELOPMENT.md §1.4](DEVELOPMENT.md#14-first-login)). Storage buckets come from avatar/photo migrations — if you only pasted `schema.sql`, also apply those migration files if buckets are missing.

---

## Keeping `schema.sql` in sync

After migrations land on prod:

1. Diff what you added (new table/RPC/policy) into `supabase/schema.sql`, **or**
2. Dump a fresh schema from a fully migrated DB and replace carefully (preserve comments/sections the team relies on).

If you skip this, the next greenfield install from `schema.sql` will drift from production.

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
| Use Direct DB URL in `db.env` | Connection failures — use Session pooler |
| Commit `scripts/db.env` | Credential leak |
| Run stamp-staging SQL on prod | Migrations marked applied without running |

---

## Related commands

| Command | Effect |
|---------|--------|
| `./scripts/db.sh migrate` | Preflight / dry-run on prod |
| `./scripts/db.sh migrate --apply` | Backup + push migrations to prod |
| `./scripts/db.sh sync` | Staging schema + replace staging data from prod |
| `./scripts/db.sh backup` | Local prod dump only |
