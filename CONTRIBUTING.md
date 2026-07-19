# Contributing

Thank you for contributing to **Bishnupriya Fuels**. Changes are reviewed before merge.

**Repo:** [github.com/fnsventures/petrolpump](https://github.com/fnsventures/petrolpump)

---

## Workflow

1. **Branch** from `staging` (preferred) or `main` for hotfixes.
2. **Develop locally** — see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
3. **Open a pull request** into `staging` (use the PR template checklist).
4. **Test on staging** after merge (`/staging/`).
5. **Production** — follow the [release checklist](docs/README.md#2-release-checklist): sync → migrate review → `migrate --apply` (quiet window) → merge `staging` → `main`.

Do not push secrets, dumps, or `js/env.js` / `scripts/db.env`.

---

## Local setup (short)

```bash
git clone https://github.com/fnsventures/petrolpump.git
cd petrolpump
cp js/env.example.js js/env.js   # add Supabase URL + anon key
npm run dev                      # http://localhost:3000
```

Provision yourself in Auth **and** `public.users` — see [README → Quick start](README.md#1-quick-start-local).

For DB scripts: `cp scripts/db.env.example scripts/db.env` and set pooler URLs.

---

## What to document

| Change type | Update |
|-------------|--------|
| New page or major flow | [docs/FLOWS.md](docs/FLOWS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Schema / RLS / RPC | Migration + [docs/DATA_TABLES.md](docs/DATA_TABLES.md) |
| DSR / stock math | [docs/DSR_TABLES.md](docs/DSR_TABLES.md) |
| Deploy / secrets / scripts | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) or [scripts/README.md](scripts/README.md) |
| Google Drive (invoices) | [docs/INVOICE_DOCUMENTS.md](docs/INVOICE_DOCUMENTS.md) |
| Google Drive (DB backup) | [docs/BACKUP.md](docs/BACKUP.md) |

---

## Security

- Never commit API keys, refresh tokens, database URLs, or backup SQL files.
- Prefer RLS and security-definer RPCs for access control; client checks are UX only.
- Destructive admin actions should stay behind admin role checks (see existing `AdminDelete` patterns).

Questions: open a PR description or issue with context (env, branch, error text).
