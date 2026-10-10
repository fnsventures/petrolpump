# Invoice documents (supplier invoices + Google Drive)

This guide covers setting up, deploying, and running the **supplier / purchase invoice vault**.

| Name in the app | What it is | Page / table |
|-----------------|------------|--------------|
| **Billing** / sales invoices | Outward lube cash memos issued to customers | `billing.html` → `invoices` + `invoice_items` |
| **Invoice documents** (this doc) | Inward supplier invoices and other vault files (PDFs, scans) | `invoices.html` → `invoice_documents` + Google Drive |

Billing PDFs, letters, and staff photos/Aadhaar use the same Drive root and Google credentials through the `drive-files` edge function.

## 1. What the feature does

- Staff upload a document from **Finance → Invoices** (`invoices.html`). Each upload has a type from `document_categories` (default `purchase`) and must be a PDF, JPEG, PNG, or WebP of 1 byte to 15 MB.
- The file goes to Google Drive and its metadata (date, type, vendor, amount, Drive IDs) goes to `invoice_documents`.
- The library lists documents for the selected period, grouped by type. Each type stays collapsed until opened. Search filters the loaded list by title, party, or file name. Users can **View** (Drive link), **Download** (through the edge function), or **Delete** (admin only).
- Settings live in **Settings → Integrations** (admin only): an enable flag and the root folder ID. Google credentials live only in **Supabase Edge Function secrets**, never in the frontend or GitHub.

## 2. Prerequisites

- One Supabase project for staging and one for prod ([OPERATIONS.md](OPERATIONS.md)), plus the [Supabase CLI](https://supabase.com/docs/guides/cli) if you deploy by hand.
- A Google account that will own the Drive folder (personal Gmail → OAuth; Shared Drive → OAuth or a service account), and a Google Cloud project. The free tier is enough and no billing account is needed.
- An admin user in `public.users`.
- Migrations applied: `20260619120000_invoice_documents_google_drive.sql` plus the later `document_categories` and `folder_layout` migrations. `./scripts/db.sh migrate` applies everything pending. If the category list is empty, seed it with `scripts/seed-document-categories.sql`.

## 3. Architecture

```
invoices.html / settings.html ──JWT──► Edge fn invoice-documents ──► Google Drive API
        │                                     │ service-role insert/delete
        └── reads invoice_documents (RLS) ◄───┘ reads pump_settings.config.integrations.googleDrive
```

**Upload flow:**

1. The browser POSTs `multipart/form-data` with the user's JWT.
2. The function checks `check_page_access('invoices')`, validates the type, size, and category, and reads the root folder ID from `pump_settings`.
3. It gets a Google access token (OAuth refresh token or service account; see [§5](#5-alternative-service-account-workspace--shared-drive) for precedence), finds or creates the folder path, and uploads the file.
4. It uploads the file **without** sharing it, then inserts the `invoice_documents` row using the service role. If the insert fails, it deletes the Drive file.

**List** reads `invoice_documents` directly through the Supabase client and RLS. **Download** and **delete** go through the edge function because the bytes live in Drive.

## 4. Complete setup (step by step)

Do this **for each Supabase project** (staging first, then prod).

### Step 1 — Apply the database migration

```bash
./scripts/db.sh migrate            # dry-run: shows pending SQL (needs scripts/db.env)
./scripts/db.sh migrate --apply    # applies
```

You can instead paste the migration into the Supabase **SQL Editor**. For a brand-new project, run all of `supabase/schema.sql`.

```sql
select count(*) from information_schema.tables
where table_schema = 'public' and table_name = 'invoice_documents';  -- 1
select public.check_page_access('invoices');  -- as supervisor/admin: allowed true
```

### Step 2 — Deploy the edge function

**CI:** `.github/workflows/deploy-supabase-functions.yml` deploys every function when `supabase/functions/**` changes on `main` or `staging`. You can also start it from **Actions → Deploy Supabase Functions → Run workflow**. It needs these GitHub environment secrets (per staging/prod): `SUPABASE_ACCESS_TOKEN` ([account tokens](https://supabase.com/dashboard/account/tokens)) and `SUPABASE_PROJECT_REF` (Project Settings → General → Reference ID).

**Manual:**

```bash
brew install supabase/tap/supabase      # or: npm install -g supabase
supabase login
supabase functions deploy invoice-documents --project-ref YOUR_PROJECT_REF
supabase functions deploy drive-files --project-ref YOUR_PROJECT_REF
```

**Verify:** call the status action. The easiest way to get a JWT is to copy it from a logged-in app session.

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/invoice-documents" \
  -H "Authorization: Bearer YOUR_JWT" -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" -d '{"action":"status"}'
```

Before Google is set up, this returns `configured: false, authMode: null`. The full response shape is in [§8](#8-edge-function-api).

### Step 3 — Google Cloud Console setup (OAuth — recommended for personal Gmail)

Use the **same Google account** that will own the Drive root folder.

#### 3.1 Create or select a Google Cloud project

Go to [Google Cloud Console](https://console.cloud.google.com/) → project dropdown → **New Project** (e.g. `bishnupriya-fuels-invoices`), then select it.

#### 3.2 Enable the Google Drive API

Go to **APIs & Services → Library → Google Drive API → Enable**. Skip this and token exchange and uploads fail with API-not-enabled errors.

#### 3.3 Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**. Choose **External** for personal Gmail, or **Internal** for Workspace only (no verification needed).
2. Fill in the app name, support email, and developer contact.
3. Add the scope `https://www.googleapis.com/auth/drive`.
4. In **Testing** mode, add the Gmail account you will authorize as a **Test user**. Testing mode is fine for this private app, and test-user refresh tokens keep working.

#### 3.4 Create OAuth client credentials

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Web application** (e.g. `Supabase invoice-documents`).
2. Under **Authorized redirect URIs**, add exactly `https://developers.google.com/oauthplayground`.
3. Click **Create**, then copy the **Client ID** and **Client secret**.

#### 3.5 Obtain a refresh token (OAuth Playground)

1. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground) and click the **gear icon**.
2. Tick **Use your own OAuth credentials** and paste the Client ID and secret. If you skip this, the token belongs to Google's Playground client and you get `unauthorized_client` later.
3. Step 1: enter the scope `https://www.googleapis.com/auth/drive` → **Authorize APIs**. Sign in as the folder-owner Gmail. If you see "Google hasn't verified this app", choose **Advanced → Go to … (unsafe)**.
4. Step 2: **Exchange authorization code for tokens**, then copy the **Refresh token**. It is long-lived, so store it securely.

The client ID, client secret, and refresh token form one set. If you regenerate any of them, regenerate and update all three. Rotation steps are in [SECRETS.md → Rotation recipes](SECRETS.md#rotation-recipes). The database backup workflow reuses the same three values ([RECOVERY.md](RECOVERY.md#setup)).

### Step 4 — Set Supabase Edge Function secrets

In **Project Settings → Edge Functions → Secrets**, or with the CLI:

```bash
supabase secrets set \
  GOOGLE_OAUTH_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
  GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret" \
  GOOGLE_OAUTH_REFRESH_TOKEN="your-refresh-token" \
  --project-ref YOUR_PROJECT_REF
```

Every function in the project can read these. Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` itself, so don't set them. Staging and prod can share one OAuth client and token or use separate ones, as long as the same Gmail owns the folders. No redeploy is needed, but allow about a minute for propagation. After that, status should show `authMode: "oauth"`.

### Step 5 — Create the Drive root folder and configure the app

1. In Drive (signed in as the token's account), create a folder and copy the ID after `/folders/` in its URL (`https://drive.google.com/drive/folders/<ROOT_ID>`).
2. Log in to the app as admin → **Settings → Integrations**, tick **Enable Google Drive storage for invoice documents**, paste the root folder ID, and click **Save integration settings**. This saves `{"integrations":{"googleDrive":{"enabled":true,"rootFolderId":"<ROOT_ID>"}}}` into `pump_settings` row `id = 1`. Edge functions cache it for about 30 s.

### Step 6 — Deploy the frontend

Push to `staging` (test at `/staging/`), then merge to `main` ([OPERATIONS.md](OPERATIONS.md#3-release-to-production)). GitHub needs only `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the frontend. Google secrets never go there.

### Step 7 — Verify end-to-end

1. Open **Finance → Invoices** as admin or supervisor. There should be no yellow banner.
2. Upload a small PDF of type Purchase. It should appear in the library and in Drive under `Root/Purchase invoices/YYYY/`. A non-purchase type is filed as `Root/Other documents/YYYY/{title}`.
3. Run `select * from invoice_documents order by created_at desc limit 1` and check that `drive_file_id` is set.
4. **View** should open Drive in a new tab, and **Download** should save the file.
5. As supervisor, upload/list/download should work with no Delete button. As admin, Delete removes the file from both Drive and the DB.

## 5. Alternative: service account (Workspace / Shared Drive)

**Do not use a service account with personal Gmail My Drive.** Service accounts have no storage quota there, so uploads fail. The page banner reports "Service accounts cannot upload to personal Gmail". A service account works only when the root folder is inside a **Shared Drive** and the service account is a member with Content manager/Editor rights. All Drive calls pass `supportsAllDrives=true`. Domain-wide delegation (impersonating a user) is **not** implemented.

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create**, then create and download a JSON key.
2. Add the key's `client_email` to the Shared Drive (or its root folder) as an Editor.
3. Set the secret with the **entire JSON on one line**. The function needs the `client_email` and `private_key` fields.

   ```bash
   supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account","client_email":"...","private_key":"..."}' --project-ref YOUR_PROJECT_REF
   ```

**Auth-mode precedence** (`resolveDriveAuthMode` in `_shared/googleDrive.ts`, shared by `invoice-documents` and `drive-files`):

1. If all three of `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REFRESH_TOKEN` are non-empty → `oauth`.
2. Otherwise, if `GOOGLE_SERVICE_ACCOUNT_JSON` is non-empty → `service_account`.
3. Otherwise → not configured.

If only one or two OAuth vars are set, the function falls back to the service account silently, or reports not configured. To use service-account mode, unset all OAuth secrets. Access tokens are cached for about 50 minutes per mode.

## 6. Roles and permissions

| Action | Admin | Supervisor |
|--------|-------|------------|
| Open page, upload, list, view, download | Yes | Yes |
| Delete (Drive + DB) | Yes | No |
| Settings → Integrations | Yes | No |

Enforcement happens in three places. `check_page_access('invoices')` runs in both `js/invoices.js` and the edge function. RLS on `invoice_documents` allows SELECT/INSERT for `is_supervisor_or_admin()` and DELETE for `is_admin()`. The edge function's delete action also requires `role === 'admin'`.

## 7. How it works at runtime

**Upload fields:** document type (required, a `document_categories.name`), date (required, `YYYY-MM-DD`, which picks the year folder for vault files), file (required), and the optional vendor ("From / party"), title, amount, and notes. For any type other than purchase, the title is the Drive file name (the uploaded name is used when the title is blank).

**Drive layout.** Folders are created on first use, and their IDs are cached in `drive_folder_cache`. There are no month folders.

```
Root (Settings)
├── Purchase invoices/YYYY/{file}         ← vault, type "purchase"
├── Other documents/YYYY/{given name}     ← vault, any other type
├── Billing invoices/YYYY/{invoice name}  ← drive-files (sales_invoice)
├── Letters/{letter name}                 ← drive-files (letter); no year folder
└── Staff/<Name · ID4>/                   ← drive-files (photo ≤ 2 MB, Aadhaar ≤ 10 MB)
```

Files uploaded before this layout keep their old Drive IDs, and Download still works for them. The `document_categories.folder_layout` column (`year_month` / `year`) exists in the DB, but the current edge code ignores it and always uses the layout above.

**Library:** the period filter offers **This year** (default), **Last year**, and **All time**, plus a type filter. It queries Postgres and never lists Drive. Results are grouped by `document_categories` order, collapsed until opened, and a search box filters that loaded list in the browser.

**Status banner:** on load the page calls `{action:"status"}`, and upload stays disabled until `configured: true`. That requires a resolved auth mode, a root folder ID, and the integration enabled. Supervisors see "Ask an admin to complete Google Drive setup". Admins are pointed to Settings → Integrations.

## 8. Edge function API

`POST {SUPABASE_URL}/functions/v1/invoice-documents`. CORS is enabled. Send `Authorization: Bearer {JWT}` and `apikey: {ANON_KEY}` on every call.

**Upload** (`multipart/form-data`): `file` (required), `invoiceDate` (required, `YYYY-MM-DD`), `category` (default `purchase`; must exist in `document_categories`), and optional `vendor`, `title`, `amount`, `notes`. Returns `{ ok: true, document: {...} }`.

**JSON actions:**

| Body | Result |
|------|--------|
| `{"action":"status"}` | `{ configured, authMode, hasOAuth, hasServiceAccount, rootFolderId, settingsEnabled, authOk, authError }`. A failed user auth is reported in `authOk`/`authError` and does not return an error status. |
| `{"action":"download","id":"<uuid>"}` | File bytes with `Content-Disposition: attachment` |
| `{"action":"delete","id":"<uuid>"}` | Admin only. Deletes the Drive file, then the row → `{ ok: true }` |

Errors come back as `{ error }` with status 400 (validation/unknown action), 403 (`Invalid session`/`Access denied`/`Admin only`), 404 (`Document not found`), or 500.

`drive-files` (used by `js/driveFiles.js`) follows the same pattern with a `kind` of `sales_invoice`, `letter`, `staff_photo`, or `staff_aadhaar`. Its actions are `status`, `archive`, `download`, and `delete`, and page access is checked against `billing`, `letterhead`, or `staff` respectively.

## 9. Database schema

`public.invoice_documents` columns: `id`, `invoice_date`, `year`, `month`, `category` (default `'purchase'`), `title`, `vendor`, `amount numeric(14,2)`, `file_name` (sanitized), `mime_type`, `file_size`, `drive_file_id`, `drive_folder_id` (the leaf folder: the year folder in the layout above), `drive_web_view_link`, `notes`, `uploaded_by → auth.users`, `created_at`. `dsr_petrol.invoice_document_id` and `dsr_diesel.invoice_document_id` may link a receipt day to a purchase PDF (`on delete set null`).

Indexes: `invoice_date desc`, `(year desc, month desc)`, `category`, and a partial `invoice_date desc where category = 'purchase'` used by reports and P&L. RLS is described in [§6](#6-roles-and-permissions). The edge function inserts with the service role. Full reference: [DATA_TABLES.md → invoice_documents](DATA_TABLES.md#invoice_documents).

## 10. Release checklist

Follow [OPERATIONS.md → Release](OPERATIONS.md#3-release-to-production), plus:

1. Deploy `invoice-documents` (and `drive-files` if it changed) **before or with** the frontend. CI does this when `supabase/functions/**` changes. If the site ships first, uploads fail.
2. Confirm the Supabase secrets, and that the integration and root folder are set in Settings.
3. On `/staging/`, test upload, download, and delete. Then smoke-test the live Invoices page.

## 11. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Banner "Google OAuth secrets are not configured on the server" | Set **all three** OAuth secrets (or the service account JSON) on the **same** project `js/env.js` points to. Check that the function is deployed there. |
| Banner "Service accounts cannot upload to personal Gmail" | Only `GOOGLE_SERVICE_ACCOUNT_JSON` resolved. Add the OAuth secrets, or move the root to a Shared Drive ([§5](#5-alternative-service-account-workspace--shared-drive)). |
| "Root folder ID is missing" / "integration is disabled in Settings" | Admin: Settings → Integrations → tick enable, paste the ID, save (allow about 30 s). |
| `Drive upload error` / `Drive list error` / 403 / 404 from Drive | The token's Gmail must own or be able to edit the root folder. The Drive API must be enabled. In Testing mode the account must be a Test user. If someone deleted or moved a folder in Drive, clear the stale IDs with `delete from drive_folder_cache;`. |
| `Invalid session` / `Access denied` (403) | Log out and back in. The user must be admin or supervisor in `public.users` and allowed by `check_page_access('invoices')`. |
| Status OK but upload fails with `Google OAuth token error` / `unauthorized_client` | The refresh token was revoked, or the client and token don't match (Playground used without own credentials, or secret rotated). Regenerate all three ([§3.4](#34-create-oauth-client-credentials)–[3.5](#35-obtain-a-refresh-token-oauth-playground)). See [SECRETS.md → Rotation recipes](SECRETS.md#rotation-recipes). |
| Edge function 404 | Deploy `invoice-documents` to that project ref. |
| Library empty after a successful upload | Check the period filter (default This year) and the type filter. Run `select * from invoice_documents order by created_at desc limit 5;`. |
| View won't open | View and Download both go through the function. A public Drive link is not used. |
| Works on staging but not prod (or the reverse) | Each project needs its own function deploy and secrets. Folder IDs can differ per environment. |

## 12. Security and privacy

- The browser sends only the user JWT. Google credentials stay in Edge Function secrets.
- Uploaded files are **not** shared as anyone-with-the-link. View and Download both require a signed-in supervisor or admin; the function reads the bytes with the Drive token. Staff photos are the exception and stay public so the image can load in the browser. Opening Vault or Reports removes any leftover file-level anyone permission on documents already in Drive.
- RLS hides metadata from anonymous and unprovisioned users. Delete is admin-only in both RLS and the function. File type and size are validated server-side.

## 13. Maintenance

- **Refresh token:** it doesn't expire unless the user revokes access ([Google Account → Third-party access](https://myaccount.google.com/permissions)), the client secret is regenerated, or too many tokens are issued for that client and user. Fix it with [§3.5](#35-obtain-a-refresh-token-oauth-playground) and update the secret.
- **Change the root folder:** create the new folder and update Settings. Existing files stay in the old tree, so move them by hand if needed. The folder cache is keyed by root ID, so no cleanup is required.
- **Change the Gmail account:** re-authorize in the Playground (new or same client), update all three secrets, and share or move the root folder to the new account. Old files stay in the previous account's Drive.
- **Edge function changes:** push to `main` or `staging` (CI), or deploy by hand — [ARCHITECTURE.md → Edge functions](ARCHITECTURE.md#65-edge-functions).

## 14. Source files reference

| File | Purpose |
|------|---------|
| `invoices.html`, `js/invoices.js` | Upload + library UI; status, upload, list, download, delete |
| `settings.html`, `js/settings.js`, `js/appConfig.js` | Integrations panel; saves and defaults `integrations.googleDrive` |
| `supabase/functions/invoice-documents/index.ts` | Vault documents ↔ Drive |
| `supabase/functions/drive-files/index.ts`, `js/driveFiles.js` | Sales invoices, letters, staff photos/Aadhaar ↔ Drive |
| `supabase/functions/_shared/googleDrive.ts` | Auth-mode resolution, tokens, folder tree and cache, upload/download/delete |
| `supabase/functions/_shared/archivePdf.ts` | Letterhead-style PDFs for billing, letters, staff files |
| `supabase/migrations/20260619120000_invoice_documents_google_drive.sql` (+ `2026072*` category migrations) | Table, RLS, page access, document types |
