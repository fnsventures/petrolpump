# Documentation

Guides for **Bishnupriya Fuels**.

---

## Start here

| Your goal | Open this |
|-----------|-----------|
| **New laptop / no Cursor — day-1 checklist** | **[ONBOARDING.md](ONBOARDING.md)** |
| **Sync / deploy / release / backup** | **[OPERATIONS.md](OPERATIONS.md)** |
| Where secrets live / how to rotate | [SECRETS.md](SECRETS.md) |
| Something is broken | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| **Data loss / bad migration / lost project** | **[DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)** |
| Add a page / migration / edge function / user | [CHECKLISTS.md](CHECKLISTS.md) |
| Add or apply DB migrations | [MIGRATIONS.md](MIGRATIONS.md) |
| See diagrams (architecture, sync, backup) | [Visual assets](#visual-assets) |
| Run on your laptop | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Understand the system | [ARCHITECTURE.md](ARCHITECTURE.md) · [FLOWS.md](FLOWS.md) |
| Change database tables | [DATA_TABLES.md](DATA_TABLES.md) · [DSR_TABLES.md](DSR_TABLES.md) |
| Supplier PDFs in Google Drive | [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| Drive backup restore (deep) | [BACKUP.md](BACKUP.md) |
| Stay on Supabase free (500 MB) + lean indexes / less duplication | [STORAGE_RETENTION.md](STORAGE_RETENTION.md) |

---

## Visual assets

Open the [root README](../README.md) for the full tour. Use **PNG** in README (GitHub blocks most SVGs).

| Diagram | PNG | SVG source |
|---------|-----|------------|
| Architecture & entry | [architecture-flow.png](assets/architecture-flow.png) | [svg](assets/architecture-flow.svg) |
| Daily data flow | [data-flow.png](assets/data-flow.png) | [svg](assets/data-flow.svg) |
| Sync prod → staging | [sync-flow.png](assets/sync-flow.png) | [svg](assets/sync-flow.svg) |
| Deploy branches | [deploy-path.png](assets/deploy-path.png) | [svg](assets/deploy-path.svg) |
| Release A→D | [release-steps.png](assets/release-steps.png) | [svg](assets/release-steps.svg) |
| Backup → Drive | [backup-flow.png](assets/backup-flow.png) | [svg](assets/backup-flow.svg) |

---

## Operations (one line each)

| Task | Action |
|------|--------|
| Sync staging DB | `./scripts/db.sh sync` |
| Apply migrations on staging (keep data) | [MIGRATIONS.md → Staging schema only](MIGRATIONS.md#staging-schema-only) |
| Deploy test website | Push / merge to `staging` |
| Check migrations | `./scripts/db.sh migrate` |
| Apply migrations on prod | `./scripts/db.sh migrate --apply` |
| Deploy live website | Merge `staging` → `main` |
| Backup prod → Drive | Actions → **Backup production database** |

Full steps: **[OPERATIONS.md](OPERATIONS.md)**

---

## Reference library

| Guide | When you need it |
|-------|------------------|
| [ONBOARDING.md](ONBOARDING.md) | Maintain the app without Cursor / AI |
| [OPERATIONS.md](OPERATIONS.md) | Day-to-day release and backup |
| [SECRETS.md](SECRETS.md) | Credential inventory and rotation |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common failures |
| [CHECKLISTS.md](CHECKLISTS.md) | Add a page / migration / edge function / user / secret |
| [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) | Tested restore, schema rollback, incident scenarios |
| [MIGRATIONS.md](MIGRATIONS.md) | Author and apply schema changes |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, GitHub envs, edge functions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Folders, security |
| [FLOWS.md](FLOWS.md) | How pages write data |
| [DATA_TABLES.md](DATA_TABLES.md) | Tables, RLS, RPCs |
| [DSR_TABLES.md](DSR_TABLES.md) | Meter / stock model |
| [DAY_CLOSING.md](DAY_CLOSING.md) | Day-closing formula; current RPC definitions |
| [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) | Invoice PDF → Drive |
| [BACKUP.md](BACKUP.md) | Drive backup setup + verify |
| [../CLAUDE.md](../CLAUDE.md) | Rules + conventions for AI agents (useful for humans too) |
| [STORAGE_RETENTION.md](STORAGE_RETENTION.md) | Free-tier size, index hygiene, anti-duplication |
| [../scripts/README.md](../scripts/README.md) | Script internals |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Pull requests |

Migrations: `supabase/migrations/` (source of truth) · Snapshot: `supabase/schema.sql` (checked by `scripts/check-schema-drift.sh`) — see [MIGRATIONS.md](MIGRATIONS.md).
