-- Vault: allow purchase invoices and other pump documents in invoice_documents

alter table public.invoice_documents
  add column if not exists category text not null default 'purchase';

create index if not exists invoice_documents_category_idx
  on public.invoice_documents (category);

comment on table public.invoice_documents is
  'Pump vault documents (purchase invoices and other important files) stored in Google Drive under year/month folders.';

comment on column public.invoice_documents.category is
  'Document type slug; display label comes from document_categories.';

comment on column public.invoice_documents.invoice_date is
  'Document date used for year/month Drive folders and library filters.';
