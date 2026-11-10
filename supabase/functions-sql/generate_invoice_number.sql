-- Canonical definition of public.generate_invoice_number. Edit here, then:
--   node scripts/sql-functions.mjs emit generate_invoice_number
create or replace function public.generate_invoice_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text;
  v_seq integer;
  v_number text;
begin
  perform public.require_staff_access();
  v_year := to_char(current_date, 'YYYY');
  v_seq := nextval('public.invoice_number_seq');
  v_number := 'CRI/' || lpad(v_seq::text, 4, '0');
  return v_number;
end;
$$;

comment on function public.generate_invoice_number() is
  'Next CRI/NNNN invoice number. Provisioned staff only.';

revoke all on function public.generate_invoice_number() from public, anon;

grant execute on function public.generate_invoice_number() to authenticated;
