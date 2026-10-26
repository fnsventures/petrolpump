-- Invoice vault: one grouped count instead of one count query per category.
-- Indexes for employee_id / product_id foreign keys that had none, so staff
-- lookups and employee/product deletes do not scan the whole table.

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

create index if not exists expenses_employee_date_idx
  on public.expenses (employee_id, date)
  where employee_id is not null;

create index if not exists credit_entries_employee_date_idx
  on public.credit_entries (employee_id, transaction_date)
  where employee_id is not null;

create index if not exists meter_shift_cash_employee_date_idx
  on public.meter_shift_cash (employee_id, reading_date desc);

create index if not exists invoice_items_product_idx
  on public.invoice_items (product_id)
  where product_id is not null;
