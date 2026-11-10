-- Canonical definition of public.apply_shift_aggregate_to_dsr. Edit here, then:
--   node scripts/sql-functions.mjs emit apply_shift_aggregate_to_dsr
create or replace function public.apply_shift_aggregate_to_dsr(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agg jsonb;
  v_block jsonb;
  v_updated text[] := array[]::text[];
  v_id uuid;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  if public.meter_day_is_locked(p_date) and not public.is_admin() then
    return jsonb_build_object(
      'date', p_date,
      'updated', '[]'::jsonb,
      'skipped_locked', true
    );
  end if;

  v_agg := public.get_shift_aggregated_daily_meters(p_date);

  -- 'updated' lists sheets that now match the shift rollup, written or already in sync.
  v_block := v_agg->'petrol';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select p.id into v_id
    from public.dsr_petrol p
    where p.date = p_date
    order by p.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_petrol p set
        opening_pump1_nozzle1 = s.opening_pump1_nozzle1,
        opening_pump1_nozzle2 = s.opening_pump1_nozzle2,
        opening_pump2_nozzle1 = s.opening_pump2_nozzle1,
        opening_pump2_nozzle2 = s.opening_pump2_nozzle2,
        closing_pump1_nozzle1 = s.closing_pump1_nozzle1,
        closing_pump1_nozzle2 = s.closing_pump1_nozzle2,
        closing_pump2_nozzle1 = s.closing_pump2_nozzle1,
        closing_pump2_nozzle2 = s.closing_pump2_nozzle2,
        sales_pump1 = s.sales_pump1,
        sales_pump2 = s.sales_pump2,
        total_sales = s.total_sales,
        testing = s.testing
      from (
        select
          coalesce((v_block->>'opening_pump1_nozzle1')::numeric, x.opening_pump1_nozzle1) as opening_pump1_nozzle1,
          coalesce((v_block->>'opening_pump1_nozzle2')::numeric, x.opening_pump1_nozzle2) as opening_pump1_nozzle2,
          coalesce((v_block->>'opening_pump2_nozzle1')::numeric, x.opening_pump2_nozzle1) as opening_pump2_nozzle1,
          coalesce((v_block->>'opening_pump2_nozzle2')::numeric, x.opening_pump2_nozzle2) as opening_pump2_nozzle2,
          coalesce((v_block->>'closing_pump1_nozzle1')::numeric, x.closing_pump1_nozzle1) as closing_pump1_nozzle1,
          coalesce((v_block->>'closing_pump1_nozzle2')::numeric, x.closing_pump1_nozzle2) as closing_pump1_nozzle2,
          coalesce((v_block->>'closing_pump2_nozzle1')::numeric, x.closing_pump2_nozzle1) as closing_pump2_nozzle1,
          coalesce((v_block->>'closing_pump2_nozzle2')::numeric, x.closing_pump2_nozzle2) as closing_pump2_nozzle2,
          coalesce((v_block->>'sales_pump1')::numeric, 0) as sales_pump1,
          coalesce((v_block->>'sales_pump2')::numeric, 0) as sales_pump2,
          coalesce((v_block->>'total_sales')::numeric, 0) as total_sales,
          coalesce((v_block->>'testing')::numeric, 0) as testing
        from public.dsr_petrol x
        where x.id = v_id
      ) s
      where p.id = v_id
        and (
          p.opening_pump1_nozzle1, p.opening_pump1_nozzle2, p.opening_pump2_nozzle1, p.opening_pump2_nozzle2,
          p.closing_pump1_nozzle1, p.closing_pump1_nozzle2, p.closing_pump2_nozzle1, p.closing_pump2_nozzle2,
          p.sales_pump1, p.sales_pump2, p.total_sales, p.testing
        ) is distinct from (
          s.opening_pump1_nozzle1, s.opening_pump1_nozzle2, s.opening_pump2_nozzle1, s.opening_pump2_nozzle2,
          s.closing_pump1_nozzle1, s.closing_pump1_nozzle2, s.closing_pump2_nozzle1, s.closing_pump2_nozzle2,
          s.sales_pump1, s.sales_pump2, s.total_sales, s.testing
        );
      v_updated := array_append(v_updated, 'petrol');
    end if;
  end if;

  v_block := v_agg->'diesel';
  if coalesce((v_block->>'has_shifts')::boolean, false) then
    select d.id into v_id
    from public.dsr_diesel d
    where d.date = p_date
    order by d.created_at desc
    limit 1;

    if v_id is not null then
      update public.dsr_diesel d set
        opening_pump1_nozzle1 = s.opening_pump1_nozzle1,
        opening_pump1_nozzle2 = s.opening_pump1_nozzle2,
        opening_pump2_nozzle1 = s.opening_pump2_nozzle1,
        opening_pump2_nozzle2 = s.opening_pump2_nozzle2,
        closing_pump1_nozzle1 = s.closing_pump1_nozzle1,
        closing_pump1_nozzle2 = s.closing_pump1_nozzle2,
        closing_pump2_nozzle1 = s.closing_pump2_nozzle1,
        closing_pump2_nozzle2 = s.closing_pump2_nozzle2,
        sales_pump1 = s.sales_pump1,
        sales_pump2 = s.sales_pump2,
        total_sales = s.total_sales,
        testing = s.testing
      from (
        select
          coalesce((v_block->>'opening_pump1_nozzle1')::numeric, x.opening_pump1_nozzle1) as opening_pump1_nozzle1,
          coalesce((v_block->>'opening_pump1_nozzle2')::numeric, x.opening_pump1_nozzle2) as opening_pump1_nozzle2,
          coalesce((v_block->>'opening_pump2_nozzle1')::numeric, x.opening_pump2_nozzle1) as opening_pump2_nozzle1,
          coalesce((v_block->>'opening_pump2_nozzle2')::numeric, x.opening_pump2_nozzle2) as opening_pump2_nozzle2,
          coalesce((v_block->>'closing_pump1_nozzle1')::numeric, x.closing_pump1_nozzle1) as closing_pump1_nozzle1,
          coalesce((v_block->>'closing_pump1_nozzle2')::numeric, x.closing_pump1_nozzle2) as closing_pump1_nozzle2,
          coalesce((v_block->>'closing_pump2_nozzle1')::numeric, x.closing_pump2_nozzle1) as closing_pump2_nozzle1,
          coalesce((v_block->>'closing_pump2_nozzle2')::numeric, x.closing_pump2_nozzle2) as closing_pump2_nozzle2,
          coalesce((v_block->>'sales_pump1')::numeric, 0) as sales_pump1,
          coalesce((v_block->>'sales_pump2')::numeric, 0) as sales_pump2,
          coalesce((v_block->>'total_sales')::numeric, 0) as total_sales,
          coalesce((v_block->>'testing')::numeric, 0) as testing
        from public.dsr_diesel x
        where x.id = v_id
      ) s
      where d.id = v_id
        and (
          d.opening_pump1_nozzle1, d.opening_pump1_nozzle2, d.opening_pump2_nozzle1, d.opening_pump2_nozzle2,
          d.closing_pump1_nozzle1, d.closing_pump1_nozzle2, d.closing_pump2_nozzle1, d.closing_pump2_nozzle2,
          d.sales_pump1, d.sales_pump2, d.total_sales, d.testing
        ) is distinct from (
          s.opening_pump1_nozzle1, s.opening_pump1_nozzle2, s.opening_pump2_nozzle1, s.opening_pump2_nozzle2,
          s.closing_pump1_nozzle1, s.closing_pump1_nozzle2, s.closing_pump2_nozzle1, s.closing_pump2_nozzle2,
          s.sales_pump1, s.sales_pump2, s.total_sales, s.testing
        );
      v_updated := array_append(v_updated, 'diesel');
    end if;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'updated', to_jsonb(v_updated),
    'skipped_locked', false
  );
end;
$$;

comment on function public.apply_shift_aggregate_to_dsr(date) is
  'Update meter columns on existing dsr_* rows from shift rollup. Never inserts stubs; leaves dip/stock/rate/remarks alone. Rows already in sync are not rewritten.';

grant execute on function public.apply_shift_aggregate_to_dsr(date) to authenticated;
