-- Canonical definition of public.stock_variance_tolerance_pct. Edit here, then:
--   node scripts/sql-functions.mjs emit stock_variance_tolerance_pct
create or replace function public.stock_variance_tolerance_pct()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
       when s.config #>> '{alerts,stockVarianceTolerancePct}' ~ '^[0-9]+(\.[0-9]+)?$'
         then (s.config #>> '{alerts,stockVarianceTolerancePct}')::numeric
     end
     from public.pump_settings s where s.id = 1),
    0.5
  );
$$;

comment on function public.stock_variance_tolerance_pct() is
  'Stock variance tolerance (% of meter sales) from pump_settings.config.alerts.stockVarianceTolerancePct; 0.5 when unset.';

grant execute on function public.stock_variance_tolerance_pct() to authenticated;
