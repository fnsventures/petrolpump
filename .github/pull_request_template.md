## Summary

What changed and why?

## Checklist

- [ ] No secrets committed (`js/env.js`, `scripts/db.env`, OAuth tokens, dumps)
- [ ] Migrations reviewed (and listed in the PR if any)
- [ ] Docs updated if behaviour, schema, or setup changed ([docs/README.md](../docs/README.md))
- [ ] Tested on staging after merge (or note why not)

## Release impact

- [ ] Frontend only (merge `staging` → `main` when ready)
- [ ] Needs `./scripts/db.sh migrate --apply` (quiet window)
- [ ] Needs edge function deploy (`supabase/functions/**` or manual)

## Reviewer

@privatefnsventures-maker
