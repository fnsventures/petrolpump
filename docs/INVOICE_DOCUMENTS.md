# Invoice documents (supplier invoices + Google Drive)

This guide explains how to set up, deploy, and operate the **supplier / purchase invoice** feature from scratch. A new person should be able to follow it end-to-end without reading source code first.

> **Documentation hub:** [README.md](README.md)

**Important naming distinction**

| Name in the app | What it is | Page / table |
|-----------------|------------|--------------|
| **Billing** / sales invoices | Outward lube cash memos you issue to customers | `billing.html` → `invoices` + `invoice_items` |
| **Invoice documents** | Inward supplier/purchase invoices (PDFs, scans) | `invoices.html` → `invoice_documents` + Google Drive |

These are separate features. This document covers **invoice documents** only.

---

## Table of contents

1. [What the feature does](#1-what-the-feature-does)
2. [Prerequisites](#2-prerequisites)
3. [Architecture](#3-architecture)
4. [Complete setup (step by step)](#4-complete-setup-step-by-step)
5. [Alternative: service account (Workspace / Shared Drive)](#5-alternative-service-account-workspace--shared-drive)
6. [Roles and permissions](#6-roles-and-permissions)
7. [How it works at runtime](#7-how-it-works-at-runtime)
8. [Edge function API](#8-edge-function-api)
9. [Database schema](#9-database-schema)
10. [Release checklist](#10-release-checklist)
11. [Troubleshooting](#11-troubleshooting)
12. [Security and privacy](#12-security-and-privacy)
13. [Maintenance](#13-maintenance)
14. [Source files reference](#14-source-files-reference)

---

## 1. What the feature does

- Staff upload **supplier invoices** (PDF, JPEG, PNG, WebP; max 15 MB) from **Finance → Invoices** (`invoices.html`).
- Files are stored in **Google Drive** under a folder layout: `RootFolder → YYYY → MonthName` (e.g. `2026/June`).
- Metadata (date, vendor, amount, Drive file ID, etc.) is stored in PostgreSQL table `invoice_documents`.
- The library lists documents by date range; users can **view** (Drive link), **download** (via edge function), or **delete** (admin only).
- Configuration lives in **Settings → Integrations** (admin only): enable flag + root folder ID.
- Google credentials live in **Supabase Edge Function secrets** — never in the frontend or GitHub.

---

## 2. Prerequisites

Before you start, make sure you have:

| Requirement | Details |
|-------------|---------|
| **Supabase project** | One for staging, one for prod (see [Development guide](DEVELOPMENT.md#2-deployment-prod-and-staging)) |
| **Supabase CLI** | For deploying the edge function: [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli) |
| **Google account** | Personal Gmail (OAuth) or Google Workspace (OAuth or service account) |
| **Google Cloud project** | Free tier is enough; billing account not required for Drive API within normal quotas |
| **Admin login** | A user provisioned as `admin` in `public.users` |
| **Database migration applied** | Migration `20260619120000_invoice_documents_google_drive.sql` |

You do **not** need Google secrets in GitHub. Only `SUPABASE_URL` and `SUPABASE_ANON_KEY` go into GitHub environment secrets (frontend). Google OAuth secrets are set only in Supabase.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                 │
│  invoices.html + js/invoices.js                                          │
│  settings.html + js/settings.js (Integrations panel)                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌───────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│ Supabase Auth │    │ PostgreSQL           │    │ Edge Function         │
│ JWT session   │    │ invoice_documents    │    │ invoice-documents     │
│               │    │ pump_settings.config │    │                       │
└───────────────┘    └─────────────────────┘    └───────────┬──────────┘
        │                       ▲                           │
        │                       │ service role insert       │
        └───────────────────────┼───────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │ Google Drive API       │
                    │ Root → YYYY → MM       │
                    └───────────────────────┘
```

**Data flow on upload**

1. User selects file + metadata on `invoices.html`.
2. Browser sends `multipart/form-data` to edge function `invoice-documents` with JWT.
3. Function verifies JWT and `check_page_access('invoices')`.
4. Function reads `pump_settings.config.integrations.googleDrive` for root folder ID.
5. Function obtains Google access token (OAuth refresh token or service account).
6. Function creates/finds `YYYY` and `MM` folders under root, uploads file to Drive.
7. Function inserts row into `invoice_documents` via service role.
8. Function sets Drive file permission to **anyone with link can view** (so View link works).
9. Browser refreshes the library (reads metadata directly from `invoice_documents` via Supabase client + RLS).

**List/download/delete**

- **List:** Client reads `invoice_documents` directly (RLS: supervisor + admin).
- **Download / delete:** Client calls edge function with `{ action: "download" }` or `{ action: "delete" }` because file bytes live in Drive, not Postgres.

---

## 4. Complete setup (step by step)

Follow these steps **for each Supabase environment** (staging first, then prod).

### Step 1 — Apply the database migration

The migration creates table `invoice_documents`, RLS policies, and adds `'invoices'` to `check_page_access`.

**Option A — Production release script (recommended for prod)**

```bash
# From repo root; requires scripts/db.env (see scripts/README.md)
./scripts/db.sh migrate          # dry-run: shows pending SQL
./scripts/db.sh migrate --apply    # applies to prod
```

**Option B — Supabase SQL Editor**

1. Open Supabase Dashboard → **SQL Editor**.
2. Paste contents of `supabase/migrations/20260619120000_invoice_documents_google_drive.sql`.
3. Run.

**Option C — Full schema (greenfield only)**

If setting up a brand-new project, you can run all of `supabase/schema.sql` instead.

**Verify**

```sql
select count(*) from information_schema.tables
where table_schema = 'public' and table_name = 'invoice_documents';
-- Should return 1

select public.check_page_access('invoices');
-- Run as authenticated user; supervisors/admins should get allowed: true
```

---

### Step 2 — Deploy the edge function

**Preferred:** GitHub Actions deploys all edge functions when `supabase/functions/**` changes on `main` or `staging` (workflow: `.github/workflows/deploy-supabase-functions.yml`). You can also run **Actions → Deploy Supabase Functions → Run workflow**.

Required GitHub environment secrets (per **staging** / **prod**):

| Secret | Purpose |
|--------|---------|
| `SUPABASE_ACCESS_TOKEN` | [Supabase Account → Access Tokens](https://supabase.com/dashboard/account/tokens) |
| `SUPABASE_PROJECT_REF` | Project Settings → General → Reference ID |

**Manual deploy** (alternative or first-time before CI is wired):

1. **Install Supabase CLI** (if not already):

   ```bash
   brew install supabase/tap/supabase
   # or: npm install -g supabase
   ```

2. **Log in and link project** (one-time per machine):

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

   Find `YOUR_PROJECT_REF` in Supabase Dashboard → **Project Settings → General → Reference ID**.

3. **Deploy the function**:

   ```bash
   cd /path/to/petrolPump
   supabase functions deploy invoice-documents --project-ref YOUR_PROJECT_REF
   ```

4. **Repeat for staging and prod** — each environment has its own project ref.

**Verify**

In Supabase Dashboard → **Edge Functions**, you should see `invoice-documents` with a recent deploy time.

Test status (requires a valid JWT — easiest from the app after login):

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/invoice-documents" \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"status"}'
```

Expected response shape (values depend on your setup):

```json
{
  "configured": false,
  "authMode": null,
  "hasOAuth": false,
  "hasServiceAccount": false,
  "rootFolderId": null,
  "settingsEnabled": false,
  "authOk": true,
  "authError": null
}
```

---

### Step 3 — Google Cloud Console setup (OAuth — recommended for personal Gmail)

Use the **same Google account** that will own the Drive root folder.

#### 3.1 Create or select a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Top bar → project dropdown → **New Project** (e.g. `bishnupriya-fuels-invoices`) or select an existing one.
3. Wait for the project to be created and select it.

#### 3.2 Enable the Google Drive API

1. **APIs & Services → Library**.
2. Search for **Google Drive API**.
3. Click **Enable**.

Without this step, token exchange and uploads fail with API-not-enabled errors.

#### 3.3 Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** (personal Gmail) or **Internal** (Google Workspace only — skips public verification).
3. Fill required fields:
   - **App name:** e.g. `Bishnupriya Fuels Invoice Storage`
   - **User support email:** your email
   - **Developer contact:** your email
4. **Scopes:** Add `https://www.googleapis.com/auth/drive` (full Drive access for upload/list/delete in the configured folder tree).
5. **Test users** (if app is in **Testing** mode): Add the Gmail address you will use for OAuth. Only listed test users can authorize until the app is published.
6. Save.

> **Testing vs Production:** For a private pump app, **Testing** mode is usually enough. Refresh tokens issued to test users continue to work; you do not need to publish the app for internal use.

#### 3.4 Create OAuth client credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Name: e.g. `Supabase invoice-documents`.
4. **Authorized redirect URIs** — add exactly:

   ```
   https://developers.google.com/oauthplayground
   ```

5. Click **Create**.
6. Copy **Client ID** and **Client secret** — you need these for Supabase secrets and OAuth Playground.

#### 3.5 Obtain a refresh token (OAuth Playground)

1. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Click the **gear icon** (OAuth 2.0 configuration).
3. Check **Use your own OAuth credentials**.
4. Paste your **Client ID** and **Client secret**.
5. Close the configuration panel.
6. In **Step 1 — Select & authorize APIs**, find **Drive API v3** or paste scope manually:

   ```
   https://www.googleapis.com/auth/drive
   ```

7. Click **Authorize APIs**.
8. Sign in with the **same Gmail account** that will own the Drive folder.
9. Accept permissions (you may see “Google hasn’t verified this app” — click **Advanced → Go to … (unsafe)** for test apps).
10. In **Step 2 — Exchange authorization code for tokens**, click **Exchange authorization code for tokens**.
11. Copy the **Refresh token** from the response. Store it securely — it is long-lived.

You only do this once per environment unless the token is revoked.

---

### Step 4 — Set Supabase Edge Function secrets

In Supabase Dashboard → **Project Settings → Edge Functions → Secrets** (or use CLI):

**Via Dashboard**

Add these three secrets for OAuth:

| Secret name | Value |
|-------------|-------|
| `GOOGLE_OAUTH_CLIENT_ID` | From step 3.4 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From step 3.4 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | From step 3.5 |

**Via CLI**

```bash
supabase secrets set \
  GOOGLE_OAUTH_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
  GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret" \
  GOOGLE_OAUTH_REFRESH_TOKEN="your-refresh-token" \
  --project-ref YOUR_PROJECT_REF
```

These are automatically available to all edge functions in that project. You do **not** set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, or `SUPABASE_SERVICE_ROLE_KEY` manually — Supabase injects them.

**Staging vs prod:** Use separate Supabase projects. You may reuse the same Google OAuth client and refresh token for both, or create separate clients — either works if the same Gmail owns the folders.

**Verify secrets**

Redeploy is not required after secret changes, but wait a minute for propagation. Call the status action again — `hasOAuth` should be `true` and `authMode` should be `"oauth"`.

---

### Step 5 — Create the Drive root folder and configure the app

1. In [Google Drive](https://drive.google.com/), sign in as the **same account** used for the refresh token.
2. Create a folder, e.g. `Supplier Invoices - Bishnupriya Fuels`.
3. Open the folder. The URL looks like:

   ```
   https://drive.google.com/drive/folders/1abcXYZexampleFolderId
   ```

4. Copy the ID after `/folders/` — that is your **root folder ID**.

5. In the app, log in as **admin** → **Settings → Integrations**:
   - Check **Enable Google Drive storage for invoice documents**
   - Paste **Root folder ID**
   - Click **Save integration settings**

Settings are stored in `pump_settings` row `id = 1`:

```json
{
  "integrations": {
    "googleDrive": {
      "enabled": true,
      "rootFolderId": "1abcXYZexampleFolderId"
    }
  }
}
```

---

### Step 6 — Deploy the frontend

Frontend deploy is automated via GitHub Actions (see [Development guide → Deployment](DEVELOPMENT.md#2-deployment-prod-and-staging)).

1. Push to `staging` branch → test at `/staging/`.
2. Merge to `main` → production.

No Google secrets in GitHub — only `SUPABASE_URL` and `SUPABASE_ANON_KEY` per environment.

---

### Step 7 — Verify end-to-end

Use this checklist after setup:

| # | Check | Expected |
|---|-------|----------|
| 1 | Log in as admin or supervisor | Access to **Finance → Invoices** |
| 2 | Open Invoices page | No yellow warning banner (Drive configured) |
| 3 | Upload a small test PDF | Success message; row appears in library |
| 4 | Google Drive | File under `RootFolder/YYYY/MM/` |
| 5 | SQL: `select * from invoice_documents order by created_at desc limit 1` | Row with `drive_file_id` populated |
| 6 | Click **View** | Opens file in Drive (new tab) |
| 7 | Click **Download** | File downloads locally |
| 8 | Log in as supervisor | Can upload/list/download; no Delete button |
| 9 | Log in as admin → Delete test file | Removed from Drive and database |

If the banner says “Google OAuth secrets are not configured”, recheck Step 4. If it says “Root folder ID is missing”, recheck Step 5.

---

## 5. Alternative: service account (Workspace / Shared Drive)

**Do not use a service account for personal Gmail My Drive.** Service accounts have no storage quota on personal Drive and uploads fail.

Use a service account only when:

- Files live in a **Shared Drive** (Team Drive), or
- A Workspace admin has delegated domain-wide access, and
- The target folder is shared with the service account email as **Editor**.

### Setup outline

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create**.
2. Create a JSON key; download the key file.
3. Share the Drive root folder (or Shared Drive) with `client_email` from the JSON as **Editor**.
4. In Supabase secrets, set:

   ```
   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...",...}
   ```

   Paste the **entire JSON on one line** (no line breaks).

5. Do **not** set OAuth secrets if you want service-account mode — or set OAuth secrets **instead** (OAuth takes precedence when all three OAuth vars are present).

The edge function prefers OAuth when `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` are all set.

---

## 6. Roles and permissions

| Action | Admin | Supervisor |
|--------|-------|------------|
| Open Invoices page | Yes | Yes |
| Upload documents | Yes | Yes |
| List / filter library | Yes | Yes |
| View (Drive link) | Yes | Yes |
| Download | Yes | Yes |
| Delete (Drive + DB) | Yes | No |
| Settings → Integrations | Yes | No |

Enforcement:

- Page access: `check_page_access('invoices')` in `js/invoices.js` and edge function.
- RLS on `invoice_documents`: SELECT/INSERT for `is_supervisor_or_admin()`; DELETE for `is_admin()` only.
- Delete action in edge function additionally checks `auth.role === 'admin'`.

---

## 7. How it works at runtime

### Upload form fields

| Field | Required | Notes |
|-------|----------|-------|
| Invoice date | Yes | `YYYY-MM-DD`; determines `YYYY/MonthName` folder (e.g. `2026/June`) |
| File | Yes | PDF, JPEG, PNG, WebP; 1 byte – 15 MB |
| Vendor | No | Free text |
| Title | No | Free text |
| Amount | No | Numeric |
| Notes | No | Free text |

### Drive folder layout

```
Root folder (from Settings)
├── 2026/
│   ├── January/
│   │   ├── invoice-jan.pdf
│   │   └── ...
│   ├── February/
│   └── June/
│       └── supplier-scan.png
└── 2025/
    └── December/
```

Folders are created automatically on first upload for each year/month.

### Library filtering

Default filter: **this month**. Also supports **this year** and **custom date range**. Metadata is queried from Postgres; files are not listed from Drive directly.

### Status banner

On page load, `js/invoices.js` calls `{ action: "status" }`. Upload is disabled until `configured: true`:

- OAuth or service account secrets present **and**
- Root folder ID set **and**
- Integration enabled in Settings

Supervisors see “Ask an admin to complete Google Drive setup”; admins see “See Settings → Integrations”.

---

## 8. Edge function API

**URL:** `{SUPABASE_URL}/functions/v1/invoice-documents`

**CORS:** Enabled for browser calls.

### POST — Upload (multipart)

**Headers:** `Authorization: Bearer {JWT}`, `apikey: {ANON_KEY}`

**Body:** `multipart/form-data`

| Field | Type | Required |
|-------|------|----------|
| file | File | Yes |
| invoiceDate | string | Yes (`YYYY-MM-DD`) |
| vendor | string | No |
| title | string | No |
| amount | string/number | No |
| notes | string | No |

**Success:** `{ ok: true, document: { id, invoice_date, ... } }`

### POST — JSON actions

**Headers:** `Authorization: Bearer {JWT}`, `Content-Type: application/json`, `apikey: {ANON_KEY}`

#### `{ "action": "status" }`

Returns configuration state (does not require full auth for the config part, but reports `authOk` / `authError`):

```json
{
  "configured": true,
  "authMode": "oauth",
  "hasOAuth": true,
  "hasServiceAccount": false,
  "rootFolderId": "1abc...",
  "settingsEnabled": true,
  "authOk": true,
  "authError": null
}
```

#### `{ "action": "download", "id": "uuid" }`

Returns file bytes with `Content-Disposition: attachment`.

#### `{ "action": "delete", "id": "uuid" }`

Admin only. Deletes Drive file then DB row. Returns `{ ok: true }`.

### Error responses

JSON body `{ error: "message" }` with HTTP status 400, 403, 404, or 500.

---

## 9. Database schema

Table: `public.invoice_documents`

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| invoice_date | date | Supplier invoice date |
| year | smallint | Derived from date |
| month | smallint | 1–12 |
| title | text | Optional description |
| vendor | text | Supplier name |
| amount | numeric(14,2) | Optional amount |
| file_name | text | Sanitized original filename |
| mime_type | text | e.g. `application/pdf` |
| file_size | bigint | Bytes |
| drive_file_id | text | Google Drive file ID |
| drive_folder_id | text | Month folder ID |
| drive_web_view_link | text | Optional view URL |
| notes | text | Optional |
| uploaded_by | uuid | FK → auth.users |
| created_at | timestamptz | Upload time |

**RLS**

- SELECT, INSERT: authenticated users where `is_supervisor_or_admin()`
- DELETE: `is_admin()` only
- Edge function INSERT uses service role (bypasses RLS)

**Indexes:** `invoice_date desc`, `(year desc, month desc)`

Full reference: [Data Tables → invoice_documents](DATA_TABLES.md#invoice_documents).

---

## 10. Release checklist

When shipping invoice-document changes to production:

| Step | Action | Environment |
|------|--------|-------------|
| 1 | Apply DB migration if new | Staging, then prod (`./scripts/db.sh migrate --apply`) |
| 2 | Deploy edge function if changed | Staging, then prod |
| 3 | Confirm Supabase secrets set | Staging, then prod |
| 4 | Enable integration + root folder in Settings | Staging, then prod |
| 5 | Push frontend to `staging`; test upload/download/delete | Staging |
| 6 | Merge to `main` | Prod |
| 7 | Smoke test on prod Invoices page | Prod |

GitHub Actions deploys **static frontend only**. If you forget step 2, uploads fail even after a successful site deploy.

---

## 11. Troubleshooting

### Banner: “Google OAuth secrets are not configured on the server”

- Set all three: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` in Supabase Edge Function secrets.
- Confirm you deployed `invoice-documents` to the **same** Supabase project the app’s `js/env.js` points to.

### Banner: “Service accounts cannot upload to personal Gmail”

- You have `GOOGLE_SERVICE_ACCOUNT_JSON` set but not OAuth. Add OAuth secrets (recommended) or switch to Shared Drive + service account (see [§5](#5-alternative-service-account-workspace--shared-drive)).

### Banner: “Root folder ID is missing in Settings → Integrations”

- Admin must enable integration and paste folder ID in Settings → Integrations.

### Upload fails: “Google Drive integration is disabled in Settings”

- Enable the checkbox in Settings → Integrations and save.

### Upload fails: “Drive upload error” / 403 / 404

- Refresh token Gmail must **own** or have **edit access** to the root folder.
- Confirm Drive API is enabled in Google Cloud Console.
- If OAuth app is in Testing mode, the authorizing user must be listed under **Test users**.

### Upload fails: “Invalid session” / 403 Access denied

- Log out and log in again.
- User must be provisioned in `public.users` as admin or supervisor.
- User must have access to page `invoices` via `check_page_access`.

### Status works but upload fails with token error

- Refresh token may be revoked. Re-run OAuth Playground (Step 3.5) and update `GOOGLE_OAUTH_REFRESH_TOKEN`.
- Client secret rotated in Google Cloud — update `GOOGLE_OAUTH_CLIENT_SECRET`.

### Edge function not found (404)

- Deploy: `supabase functions deploy invoice-documents --project-ref ...`

### Library empty but upload succeeded

- Check date filter on Invoices page (default: this month).
- Query: `select * from invoice_documents where invoice_date >= current_date - interval '30 days';`

### View link does not open

- Upload sets `anyone` reader permission; if org policy blocks public sharing, View may fail — Download still works via edge function.

### Staging works, prod does not (or vice versa)

- Each Supabase project needs its **own** function deploy and secrets.
- Each environment’s Settings → Integrations may have different folder IDs.

---

## 12. Security and privacy

- **Google credentials** never leave Supabase Edge Function secrets; the browser only sends the user JWT.
- **Uploaded files** get Drive permission `type: anyone, role: reader` so the web view link works. Anyone with the link can view the file. For highly sensitive invoices, consider org policies or Shared Drive with stricter sharing.
- **RLS** limits database metadata to provisioned staff; anonymous users cannot list `invoice_documents`.
- **Delete** is admin-only in both RLS and edge function.
- **File type and size** are validated server-side (not only in the browser).

---

## 13. Maintenance

### Refresh token rotation

Google refresh tokens for OAuth Playground clients typically do not expire unless:

- User revokes app access in [Google Account → Security → Third-party access](https://myaccount.google.com/permissions)
- OAuth client secret is regenerated and old tokens invalidated
- Too many refresh tokens issued for the same client/user (rare for a single-server app)

If uploads start failing with OAuth token errors, generate a new refresh token (Step 3.5) and update the Supabase secret.

### Changing the root folder

1. Create new folder in Drive; copy new ID.
2. Update Settings → Integrations.
3. Existing files remain in the old folder tree; new uploads go to the new root. Migrate old files manually in Drive if needed.

### Changing Gmail account

1. Create new OAuth credentials or reuse client with new Playground authorization.
2. Update all three OAuth secrets.
3. Share or move root folder to the new account.
4. Old files remain under the previous account’s Drive.

### Edge function updates

After editing `supabase/functions/invoice-documents/index.ts`, either:

- Push to `main` / `staging` (Actions deploys when `supabase/functions/**` changes), or
- Deploy manually:

```bash
supabase functions deploy invoice-documents --project-ref YOUR_PROJECT_REF
```

Repeat for each Supabase project (staging and prod).
---

## 14. Source files reference

| File | Purpose |
|------|---------|
| `invoices.html` | Upload + library UI |
| `js/invoices.js` | Client logic: status, upload, list, download, delete |
| `settings.html` | Integrations panel (short OAuth steps in UI) |
| `js/settings.js` | Saves `integrations.googleDrive` to pump_settings |
| `js/appConfig.js` | Default `integrations.googleDrive` |
| `supabase/functions/invoice-documents/index.ts` | Drive API + auth + upload/download/delete |
| `supabase/migrations/20260619120000_invoice_documents_google_drive.sql` | Table, RLS, page access |
| `sw.js` | Caches `invoices.html` and `js/invoices.js` |

---

## Related documentation

| Document | Description |
|----------|-------------|
| [Development guide](DEVELOPMENT.md) | Local setup, deployment, database scripts |
| [Architecture](ARCHITECTURE.md) | Project structure, edge functions overview |
| [Data Tables](DATA_TABLES.md) | `invoice_documents`, `pump_settings.integrations` |
| [Flows](FLOWS.md) | Supplier invoice user flow |
| [scripts/README.md](../scripts/README.md) | Database migration commands |
