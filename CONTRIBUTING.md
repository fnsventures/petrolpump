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

A new laptop: [docs/START.md](docs/START.md).

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

Full setup: [docs/START.md](docs/START.md)  
Secrets: [docs/SECRETS.md](docs/SECRETS.md)

---

## Database changes

1. `supabase migration new <name>` (never rewrite an applied migration; new files must sort last)
2. Test via staging (`./scripts/db.sh sync` or release Step C)
3. Update `supabase/schema.sql` (`./scripts/check-schema-drift.sh` must pass) and [docs/DATA_TABLES.md](docs/DATA_TABLES.md) when the public model changes

Guide: [docs/MIGRATIONS.md](docs/MIGRATIONS.md) · Recipes: [docs/CHECKLISTS.md](docs/CHECKLISTS.md)

---

## PR checks

`.github/workflows/pr-checks.yml` runs on every PR into `staging`/`main`. Four jobs, all required before merge ([repository rules](docs/OPERATIONS.md#github-setup)):

- **Build site + JS syntax + doc links**: unit tests, CSS colours, ESLint (undeclared globals), `tsc` on `// @ts-check` files against the DB types, `node --check`, the same build Deploy runs (`scripts/build-deploy.mjs`), Markdown links.
- **Migration names + order + function sources.**
- **Secret scan**: no `env.js` / `db.env` / dumps tracked (`scripts/check-forbidden-files.sh`), and gitleaks over every commit in the PR (`.gitleaks.toml`).
- **Database**: when migrations, `schema.sql`, tests or types change, schema drift, pgTAP and a `types/db.d.ts` freshness check, all in throwaway Docker Postgres.

 Dependabot opens weekly npm and Actions update PRs into `staging`. Run the same locally:

```bash
npm run lint:js
npm run typecheck
node scripts/check-doc-links.mjs
./scripts/check-migration-order.sh
./scripts/check-schema-drift.sh   # Docker
./scripts/check-forbidden-files.sh
```

---

## Docs to update when you change…

| You changed… | Also update |
|--------------|-------------|
| Tables / RLS / RPCs / meter model | `supabase/schema.sql`, [DATA_TABLES.md](docs/DATA_TABLES.md) |
| Secrets / CI env vars | [SECRETS.md](docs/SECRETS.md) |
| Release / sync / backup | [OPERATIONS.md](docs/OPERATIONS.md), [RECOVERY.md](docs/RECOVERY.md) |
| Page → data behaviour | [FLOWS.md](docs/FLOWS.md) |
| Invoice Drive / OAuth | [INVOICE_DOCUMENTS.md](docs/INVOICE_DOCUMENTS.md) |
