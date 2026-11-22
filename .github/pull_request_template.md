## Summary

What changed and why?

## Checklist

- [ ] No secrets committed (`js/env.js`, `scripts/db.env`, OAuth tokens, dumps)
- [ ] Migrations reviewed (and listed in the PR if any); `supabase/schema.sql` updated
- [ ] New page / edge function / user / secret → followed [docs/CHECKLISTS.md](../docs/CHECKLISTS.md)
- [ ] Docs updated if behaviour, schema, or setup changed ([docs/README.md](../docs/README.md))
- [ ] Tested on staging after merge (or note why not)

## Release impact

See [docs/OPERATIONS.md](../docs/OPERATIONS.md).

- [ ] Frontend only (merge `staging` → `main` when ready)
- [ ] Has migrations: the prod Deploy will wait for **prod-migrations** approval (approve in a quiet window)
- [ ] Changes edge functions (`supabase/functions/**` deploys automatically on merge)

## Reviewer

@privatefnsventures-maker
