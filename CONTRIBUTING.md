# Contributing

Thanks for contributing to **Bishnupriya Fuels**.

**Repo:** [github.com/fnsventures/petrolpump](https://github.com/fnsventures/petrolpump)

---

## How we ship

Use **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for sync, staging deploy, release, and backup.

1. Branch from `staging`
2. Open a PR into `staging`
3. Test on `/staging/`
4. Release with the Operations playbook (migrate if needed, then merge to `main`)

Never commit secrets, dumps, `js/env.js`, or `scripts/db.env`.

**Maintain without Cursor:** [docs/ONBOARDING.md](docs/ONBOARDING.md)

---

## Local setup

```bash
git clone https://github.com/fnsventures/petrolpump.git
cd petrolpump
# Node 22 — see .nvmrc
npm ci
cp js/env.example.js js/env.js
npm run dev
```

Full setup: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)  
Secrets: [docs/SECRETS.md](docs/SECRETS.md)

---

## Database changes

1. `supabase migration new <name>` (never rewrite an applied migration; new files must sort last)
2. Test via staging (`./scripts/db.sh sync` or release Step C)
3. Update `supabase/schema.sql` (`./scripts/check-schema-drift.sh` must pass) and [docs/DATA_TABLES.md](docs/DATA_TABLES.md) when the public model changes

Guide: [docs/MIGRATIONS.md](docs/MIGRATIONS.md) · Recipes: [docs/CHECKLISTS.md](docs/CHECKLISTS.md)

---

## PR checks

`.github/workflows/pr-checks.yml` runs on every PR into `staging`/`main`: deploy-style build, `node --check` on all JS, Markdown link check, migration name/order check, and (when `supabase/` changes) the schema-drift check. Run the same locally:

```bash
node scripts/check-doc-links.mjs
./scripts/check-migration-order.sh
./scripts/check-schema-drift.sh   # Docker
```

---

## Docs to update when you change…

| You changed… | Also update |
|--------------|-------------|
| Tables / RLS / RPCs | `supabase/schema.sql`, [DATA_TABLES.md](docs/DATA_TABLES.md) |
| DSR / meter model | [DSR_TABLES.md](docs/DSR_TABLES.md) |
| Secrets / CI env vars | [SECRETS.md](docs/SECRETS.md), [DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Release / sync / backup steps | [OPERATIONS.md](docs/OPERATIONS.md) |
| Page → data behaviour | [FLOWS.md](docs/FLOWS.md) |
| Invoice Drive / OAuth | [INVOICE_DOCUMENTS.md](docs/INVOICE_DOCUMENTS.md) |
