-- Canonical definition of public.get_invoice_document_category_counts. Edit here, then:
--   node scripts/sql-functions.mjs emit get_invoice_document_category_counts
create or replace function public.get_invoice_document_category_counts(
  p_start date default null,
  p_end date default null
)
returns table (category text, doc_count bigint, latest_date date)
language sql
stable
security invoker
set search_path = public
as $$
  select d.category, count(*)::bigint, max(d.invoice_date)
  from public.invoice_documents d
  where (p_start is null or d.invoice_date >= p_start)
    and (p_end is null or d.invoice_date <= p_end)
  group by d.category;
$$;

comment on function public.get_invoice_document_category_counts(date, date) is
  'Invoice vault outline: document count and latest invoice_date per category in an optional date range. Runs as the caller, so invoice_documents RLS applies.';

grant execute on function public.get_invoice_document_category_counts(date, date) to authenticated;
