# Documentation

Guides for **Bishnupriya Fuels**.

---

## Start here

| Your goal | Open this |
|-----------|-----------|
| **Sync / deploy / release / backup** | **[OPERATIONS.md](OPERATIONS.md)** |
| See animated flows (architecture, sync, backup) | [../README.md](../README.md#visual-tour) |
| Run on your laptop | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Understand the system | [ARCHITECTURE.md](ARCHITECTURE.md) · [FLOWS.md](FLOWS.md) |
| Change database tables | [DATA_TABLES.md](DATA_TABLES.md) · [DSR_TABLES.md](DSR_TABLES.md) |
| Supplier PDFs in Google Drive | [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| Drive backup restore (deep) | [BACKUP.md](BACKUP.md) |

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
| [OPERATIONS.md](OPERATIONS.md) | Day-to-day release and backup |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local setup, secrets, edge functions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Folders, security |
| [FLOWS.md](FLOWS.md) | How pages write data |
| [DATA_TABLES.md](DATA_TABLES.md) | Tables, RLS, RPCs |
| [DSR_TABLES.md](DSR_TABLES.md) | Meter / stock model |
| [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) | Invoice PDF → Drive |
| [BACKUP.md](BACKUP.md) | Backup restore |
| [../scripts/README.md](../scripts/README.md) | Script internals |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Pull requests |

Schema source of truth: `supabase/schema.sql`
