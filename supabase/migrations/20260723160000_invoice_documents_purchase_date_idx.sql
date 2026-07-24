-- Speed vault purchase range queries used by reports / P&L (category + invoice_date).

create index if not exists invoice_documents_purchase_date_idx
  on public.invoice_documents (invoice_date desc)
  where category = 'purchase';

comment on index public.invoice_documents_purchase_date_idx is
  'Partial index for purchase vault lookups by invoice_date (reports/P&L lube COGS).';
