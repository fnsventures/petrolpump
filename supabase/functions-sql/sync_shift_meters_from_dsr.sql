-- Canonical definition of public.sync_shift_meters_from_dsr. Edit here, then:
--   node scripts/sql-functions.mjs emit sync_shift_meters_from_dsr
create or replace function public.sync_shift_meters_from_dsr(
  p_date date,
  p_shift text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text;
  v_has_afternoon boolean;
  v_updated int := 0;
  v_n int;
begin
  perform public.require_staff_access();
  perform public.require_meter_day_writable(p_date);

  if p_date is null then
    raise exception 'Date is required';
  end if;

  v_shift := nullif(lower(btrim(coalesce(p_shift, ''))), '');
  if v_shift is not null and v_shift not in ('morning', 'afternoon') then
    raise exception 'Shift must be morning or afternoon';
  end if;

  select exists(
    select 1 from public.meter_shift_readings
    where reading_date = p_date and shift = 'afternoon'
  )
  into v_has_afternoon;

  -- Morning: align openings from complete daily only
  with daily as (
    (
      select 'petrol'::text as product,
        p.opening_pump1_nozzle1 as o11, p.opening_pump1_nozzle2 as o12,
        p.opening_pump2_nozzle1 as o21, p.opening_pump2_nozzle2 as o22
      from public.dsr_petrol p
      where p.date = p_date
        and public.dsr_meter_row_is_complete(
          p.petrol_rate, p.dip_reading, p.stock, p.receipts
        )
      order by p.created_at desc
      limit 1
    )
    union all
    (
      select 'diesel'::text,
        d.opening_pump1_nozzle1, d.opening_pump1_nozzle2,
        d.opening_pump2_nozzle1, d.opening_pump2_nozzle2
      from public.dsr_diesel d
      where d.date = p_date
        and public.dsr_meter_row_is_complete(
          d.diesel_rate, d.dip_reading, d.stock, d.receipts
        )
      order by d.created_at desc
      limit 1
    )
  ),
  nozzles as (
    select product, 1::smallint as pump_no, 1::smallint as nozzle_no, o11 as opening from daily
    union all select product, 1, 2, o12 from daily
    union all select product, 2, 1, o21 from daily
    union all select product, 2, 2, o22 from daily
  )
  update public.meter_shift_readings r set
    opening_meter = coalesce(n.opening, r.opening_meter),
    closing_meter = greatest(r.closing_meter, coalesce(n.opening, r.opening_meter)),
    updated_at = timezone('utc'::text, now())
  from nozzles n
  where r.reading_date = p_date
    and r.shift = 'morning'
    and r.product = n.product
    and r.pump_no = n.pump_no
    and r.nozzle_no = n.nozzle_no
    and (v_shift is null or v_shift = 'morning');

  get diagnostics v_n = row_count;
  v_updated := v_updated + coalesce(v_n, 0);

  if v_has_afternoon and (v_shift is null or v_shift = 'afternoon') then
    with daily as (
      (
        select 'petrol'::text as product,
          p.closing_pump1_nozzle1 as c11, p.closing_pump1_nozzle2 as c12,
          p.closing_pump2_nozzle1 as c21, p.closing_pump2_nozzle2 as c22
        from public.dsr_petrol p
        where p.date = p_date
          and public.dsr_meter_row_is_complete(
            p.petrol_rate, p.dip_reading, p.stock, p.receipts
          )
        order by p.created_at desc
        limit 1
      )
      union all
      (
        select 'diesel'::text,
          d.closing_pump1_nozzle1, d.closing_pump1_nozzle2,
          d.closing_pump2_nozzle1, d.closing_pump2_nozzle2
        from public.dsr_diesel d
        where d.date = p_date
          and public.dsr_meter_row_is_complete(
            d.diesel_rate, d.dip_reading, d.stock, d.receipts
          )
        order by d.created_at desc
        limit 1
      )
    ),
    nozzles as (
      select product, 1::smallint as pump_no, 1::smallint as nozzle_no, c11 as closing from daily
      union all select product, 1, 2, c12 from daily
      union all select product, 2, 1, c21 from daily
      union all select product, 2, 2, c22 from daily
    )
    update public.meter_shift_readings r set
      closing_meter = greatest(coalesce(n.closing, r.closing_meter), r.opening_meter),
      updated_at = timezone('utc'::text, now())
    from nozzles n
    where r.reading_date = p_date
      and r.shift = 'afternoon'
      and r.product = n.product
      and r.pump_no = n.pump_no
      and r.nozzle_no = n.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  -- Afternoon opening = morning closing (handoff continuity)
  if v_shift is null or v_shift = 'afternoon' then
    update public.meter_shift_readings aft set
      opening_meter = m.closing_meter,
      closing_meter = greatest(aft.closing_meter, m.closing_meter),
      updated_at = timezone('utc'::text, now())
    from public.meter_shift_readings m
    where aft.reading_date = p_date
      and aft.shift = 'afternoon'
      and m.reading_date = p_date
      and m.shift = 'morning'
      and m.product = aft.product
      and m.pump_no = aft.pump_no
      and m.nozzle_no = aft.nozzle_no;

    get diagnostics v_n = row_count;
    v_updated := v_updated + coalesce(v_n, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'shift', v_shift,
    'ok', true,
    'rows_touched', v_updated
  );
end;
$$;

comment on function public.sync_shift_meters_from_dsr(date, text) is
  'Push openings/closings from a finished meter sheet into shift rows; handoff afternoon open from morning close.';
