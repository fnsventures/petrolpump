# Onboarding — maintain without Cursor

Day-1 checklist so you can run, fix, and release **Bishnupriya Fuels** from this repo alone (terminal + browser + GitHub + Supabase).

**Playbook for daily work:** [OPERATIONS.md](OPERATIONS.md)  
**Secrets map:** [SECRETS.md](SECRETS.md)  
**When something breaks:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

---

## Access you need

| System | Why | Where |
|--------|-----|-------|
| GitHub repo `fnsventures/petrolpump` | Code, PRs, Actions, environments | [github.com/fnsventures/petrolpump](https://github.com/fnsventures/petrolpump) |
| Supabase **prod** + **staging** | Auth, DB, Storage, Edge Functions | [supabase.com/dashboard](https://supabase.com/dashboard) |
| Google Drive (backup folder) | Monthly DB dumps | Folder ID in GitHub **prod** secret |
| Google Cloud OAuth (optional) | Invoice PDFs + Drive backup | Same client as [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) |
| GoDaddy (optional) | DNS for `*.fnsventures.in` | Only if you edit DNS |

Code owners for critical paths: see `.github/CODEOWNERS`.

---

## Day 1 — laptop

1. Install **Node.js 22** (see `.nvmrc`), [Supabase CLI](https://supabase.com/docs/guides/cli), and Docker Desktop **or** `libpq`.
2. Clone and install:

```bash
git clone https://github.com/fnsventures/petrolpump.git
cd petrolpump
npm ci
```

3. Frontend config:

```bash
cp js/env.example.js js/env.js
# Set SUPABASE_URL + SUPABASE_ANON_KEY (staging project is fine for local)
```

4. DB scripts config:

```bash
cp scripts/db.env.example scripts/db.env
# Session pooler URLs (port 5432) for prod + staging
```

5. Run locally:

```bash
npm run dev
# → http://localhost:3000
```

6. Confirm login: Auth user **and** a row in `public.users` (see [DEVELOPMENT.md §1.4](DEVELOPMENT.md#14-first-login)).

7. Confirm scripts:

```bash
./scripts/db.sh help
```

---

## Day 1 — read these (in order)

| # | Doc | Why |
|---|-----|-----|
| 1 | [OPERATIONS.md](OPERATIONS.md) | Sync, deploy, release, backup |
| 2 | [SECRETS.md](SECRETS.md) | Where every credential lives |
| 3 | [DEVELOPMENT.md](DEVELOPMENT.md) | Local + GitHub environments |
| 4 | [MIGRATIONS.md](MIGRATIONS.md) | How to change the database safely |
| 5 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common failures |
| 6 | [ARCHITECTURE.md](ARCHITECTURE.md) | Folders and security model |

---

## Mental model (do not mix these up)

| Action | Changes website? | Changes prod DB data? | Changes prod schema? |
|--------|------------------|------------------------|----------------------|
| Push / merge → `staging` | Staging only | No | No |
| Merge `staging` → `main` | Production | No | No |
| `./scripts/db.sh sync` | No | No (staging **data** replaced) | Staging schema may update |
| `./scripts/db.sh migrate` | No | No | No (dry-run) |
| `./scripts/db.sh migrate --apply` | No | No | **Yes** |
| Actions → Backup | No | No (read-only dump) | No |

---

## Environments cheat sheet

| | Production | Staging |
|--|------------|---------|
| Git branch | `main` | `staging` |
| Site | `https://bishnupriyafuels.fnsventures.in/` | `…/staging/` |
| Supabase | Prod project | Staging project |
| GitHub environment secrets | `prod` | `staging` |

---

## Weekly habits (no AI required)

- [ ] Open Actions — last **Deploy** on `main` / `staging` green?
- [ ] Once a month: confirm Drive backup folder has a new `YYYY/YYYY-MM/` dump (or run the workflow)
- [ ] Before any release: smoke-test `/staging/` after sync
- [ ] Never commit `js/env.js`, `scripts/db.env`, dumps, or OAuth tokens

---

## If you only remember three commands

```bash
./scripts/db.sh sync              # real data on staging
./scripts/db.sh migrate           # safe: what would apply on prod
./scripts/db.sh migrate --apply   # quiet window only — upgrades prod schema
```

Ship frontend: merge to `staging` → test → merge to `main`. Full order: [OPERATIONS.md §3](OPERATIONS.md#3-release-to-production).
