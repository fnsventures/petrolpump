# Documentation

One place for each fact. Start with the row that matches the job.

## Run it

| Guide | Use it when |
|-------|-------------|
| [Start](START.md) | New laptop. Local app, first login, prod vs staging |
| [Operations](OPERATIONS.md) | Sync, deploy, release, DNS |
| [Recovery](RECOVERY.md) | Backups, restore, a bad migration, a lost project |
| [Secrets](SECRETS.md) | Where a credential lives, and how to rotate it |
| [Troubleshooting](TROUBLESHOOTING.md) | Something is broken |

## Change it

| Guide | Use it when |
|-------|-------------|
| [Checklists](CHECKLISTS.md) | Add a page, migration, edge function, user, or secret |
| [Migrations](MIGRATIONS.md) | Author a schema change and keep `schema.sql` honest |
| [Architecture](ARCHITECTURE.md) | Folders, runtime, security, edge functions |
| [Flows](FLOWS.md) | How a page writes data |
| [Data tables](DATA_TABLES.md) | Tables, views, RLS, RPCs. Includes the meter and stock model |
| [Day closing](DAY_CLOSING.md) | The short formula and which migration defines each function |
| [Invoices](INVOICE_DOCUMENTS.md) | Supplier PDFs in Google Drive |
| [Storage](STORAGE_RETENTION.md) | Stay inside the 500 MB free database |

Agent rules: [CLAUDE.md](../CLAUDE.md). Pull requests: [CONTRIBUTING.md](../CONTRIBUTING.md). Script internals: [scripts/README.md](../scripts/README.md).

Schema changes live in `supabase/migrations/`. `supabase/schema.sql` is the snapshot; `scripts/check-schema-drift.sh` checks they match.

## Pictures

The [root README](../README.md) is the short tour. GitHub renders the PNGs.

| | PNG | Source |
|--|-----|--------|
| Architecture | [png](assets/architecture-flow.png) | [svg](assets/architecture-flow.svg) |
| Daily data | [png](assets/data-flow.png) | [svg](assets/data-flow.svg) |
| Sync | [png](assets/sync-flow.png) | [svg](assets/sync-flow.svg) |
| Deploy | [png](assets/deploy-path.png) | [svg](assets/deploy-path.svg) |
| Release | [png](assets/release-steps.png) | [svg](assets/release-steps.svg) |
| Backup | [png](assets/backup-flow.png) | [svg](assets/backup-flow.svg) |

## Commands

| I want to… | Do this |
|------------|---------|
| Test with live data on staging | `./scripts/db.sh sync` |
| Apply SQL on staging and keep its rows | [Operations → Staging schema](OPERATIONS.md#apply-migrations-to-staging-only) |
| Publish the test site | Push or merge to `staging` |
| See what would change on prod | `./scripts/db.sh migrate` |
| Upgrade the live schema | `./scripts/db.sh migrate --apply` |
| Publish the live site | Merge `staging` → `main` |
| Save the database | [Recovery](RECOVERY.md) |
