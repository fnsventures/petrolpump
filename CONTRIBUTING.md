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

---

## Local setup

```bash
git clone https://github.com/fnsventures/petrolpump.git
cd petrolpump
cp js/env.example.js js/env.js
npm run dev
```

Full setup: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
