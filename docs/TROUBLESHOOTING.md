# Troubleshooting

Unified fixes. Prefer this page when something is broken; deep dives link out.

**Ops playbook:** [OPERATIONS.md](OPERATIONS.md) · **Secrets:** [SECRETS.md](SECRETS.md)

---

## Website / login

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Banner: config missing / copy `env.example.js` | DNS or bad `env.js` on Pages | `./scripts/check-dns-siblings.sh` then open `/js/env.js`. If DNS OK → Actions → **Deploy** → `prod`. Hard-refresh after. |
| Login works, every page empty / RLS errors | User not in `public.users` | Insert admin/supervisor row ([DEVELOPMENT.md §1.4](DEVELOPMENT.md#14-first-login)) |
| Staging shows prod data project (or vice versa) | Wrong GitHub env secrets | Check **staging** / **prod** `SUPABASE_URL` + `SUPABASE_ANON_KEY`, redeploy |
| Live site unchanged after merge | Deploy still running, or SW cache | Wait for Actions **Deploy**; hard-refresh / unregister SW; bump `CACHE_VERSION` in `sw.js` if needed |
| Supervisor sees Settings / Reports | Wrong role or cached role | Confirm `public.users.role`; sign out/in |
| Direct URL to admin page blocked | Expected for supervisors | `check_page_access` — use an admin account |

---

## Database scripts

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Sync / migrate cannot connect | Direct URL or bad password encoding | Session pooler `:5432` in `scripts/db.env`; encode `@` → `%40` |
| Sync OK but photos missing on staging | Expected | Sync does **not** copy Storage file bytes ([scripts/README.md](../scripts/README.md)) |
| Migrate says already applied but object missing | Manual stamp / drift | Do not stamp blindly; inspect `supabase_migrations.schema_migrations`; restore from backup if needed |
| Accidental destructive SQL | — | Restore from Drive or `scripts/.prod-backups/` ([BACKUP.md](BACKUP.md)) |

Full error table: [scripts/README.md](../scripts/README.md).

---

## Backup / Google Drive

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `unauthorized_client` | OAuth trio mismatch | Regenerate client ID + secret + refresh token **together**; update GitHub **prod** (and Edge secrets if invoices) |
| Workflow green but no files | Wrong folder ID | Check `GOOGLE_DRIVE_BACKUP_FOLDER_ID` |
| Local backup works, Actions fails | Missing GitHub secrets | [SECRETS.md](SECRETS.md) prod table |

Deep guide: [BACKUP.md](BACKUP.md) · run steps: [OPERATIONS.md §4](OPERATIONS.md#4-backup-production-database).

---

## Invoices (supplier PDFs)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Upload fails / Drive errors | Edge secrets or OAuth | [INVOICE_DOCUMENTS.md](INVOICE_DOCUMENTS.md) troubleshooting sections |
| Function missing, UI partially works | Client fallback | Deploy `invoice-documents` to that Supabase project ([DEVELOPMENT.md §2.5](DEVELOPMENT.md#25-edge-functions)) |

---

## DNS / sibling apps

Several apps share `fnsventures.in`. A missing CNAME looks like “configuration missing” because HTML can be cached while `/js/env.js` fails.

```bash
./scripts/check-dns-siblings.sh
./scripts/check-dns-siblings.sh --fix   # needs GODADDY_* secrets
```

Verify:

- `https://bishnupriyafuels.fnsventures.in/js/env.js`
- `https://fnscashline.fnsventures.in/js/env.js`

Details: [OPERATIONS.md — DNS](OPERATIONS.md#dns-safety-net-fnsventuresin).

---

## Edge functions / slow pages

| Function | If missing |
|----------|------------|
| `get-dashboard-data`, `get-reports-data`, `get-pl-data` | Client falls back to direct queries (slower) |
| `invoice-documents` | Drive upload/download broken |

Deploy via Actions (on `supabase/functions/**` push) or CLI — [DEVELOPMENT.md §2.5](DEVELOPMENT.md#25-edge-functions).

---

## Local development

| Symptom | Fix |
|---------|-----|
| Nav looks broken / raw `{% include %}` | Use `npm run dev` (expands Nunjucks), not raw `python3 -m http.server` on source |
| Stale JS/CSS after edit | Hard-refresh; unregister service worker |
| CORS / Auth weirdness | Always serve over `http://localhost` (not `file://`) |

---

## Incident quick paths

| Severity | First move |
|----------|------------|
| Site down / wrong config banner | DNS check → redeploy prod |
| Bad release (frontend only) | Revert merge on `main` or redeploy previous `ref` via Actions |
| Bad migration / data | Stop writes if possible → restore from latest Drive/local backup ([BACKUP.md](BACKUP.md)) |
| OAuth broken | Invoices + backups both affected — rotate OAuth trio ([SECRETS.md](SECRETS.md)) |

---

## Still stuck?

1. GitHub Actions logs for the failing workflow  
2. Supabase → Logs (Auth / Postgres / Edge)  
3. Browser console + Network tab on `/js/env.js` and the failing RPC  
4. [ARCHITECTURE.md](ARCHITECTURE.md) security model if it smells like RLS  
