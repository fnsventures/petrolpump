-- Canonical definition of public.dsr_meter_row_is_complete. Edit here, then:
--   node scripts/sql-functions.mjs emit dsr_meter_row_is_complete
create or replace function public.dsr_meter_row_is_complete(
  p_selling_rate numeric,
  p_dip_reading numeric,
  p_stock numeric,
  p_receipts numeric
)
returns boolean
language sql
immutable
as $$
  select
    (p_selling_rate is not null and p_selling_rate > 0)
    and (
      coalesce(p_dip_reading, 0) <> 0
      or coalesce(p_stock, 0) > 0
    );
$$;

comment on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) is
  'True when daily meter sheet is finished: selling rate set and dip or stock entered. Receipts/rate alone do not count.';

grant execute on function public.dsr_meter_row_is_complete(numeric, numeric, numeric, numeric) to authenticated;
