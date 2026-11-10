-- Canonical definition of public.enqueue_drive_pdf_from_invoice. Edit here, then:
--   node scripts/sql-functions.mjs emit enqueue_drive_pdf_from_invoice
create or replace function public.enqueue_drive_pdf_from_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enqueue_drive_pdf_archive('sales_invoice', new.id);
  return new;
end;
$$;
