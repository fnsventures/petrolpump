-- Canonical definition of public.get_shift_aggregated_daily_meters. Edit here, then:
--   node scripts/sql-functions.mjs emit get_shift_aggregated_daily_meters
create or replace function public.get_shift_aggregated_daily_meters(p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_product text;
  v_result jsonb := jsonb_build_object('date', p_date);
  v_o11 numeric; v_o12 numeric; v_o21 numeric; v_o22 numeric;
  v_c11 numeric; v_c12 numeric; v_c21 numeric; v_c22 numeric;
  v_test numeric;
  v_s1 numeric; v_s2 numeric;
  v_has_any boolean;
  v_has_morning boolean;
  v_has_afternoon boolean;
begin
  perform public.require_staff_access();

  if p_date is null then
    raise exception 'Date is required';
  end if;

  foreach v_product in array array['petrol', 'diesel']
  loop
    select
      q.has_any,
      q.has_morning,
      q.has_afternoon,
      coalesce(q.o11_m, q.o11_a),
      coalesce(q.o12_m, q.o12_a),
      coalesce(q.o21_m, q.o21_a),
      coalesce(q.o22_m, q.o22_a),
      coalesce(q.c11_a, q.c11_m),
      coalesce(q.c12_a, q.c12_m),
      coalesce(q.c21_a, q.c21_m),
      coalesce(q.c22_a, q.c22_m),
      q.testing,
      q.s1,
      q.s2
    into
      v_has_any,
      v_has_morning,
      v_has_afternoon,
      v_o11, v_o12, v_o21, v_o22,
      v_c11, v_c12, v_c21, v_c22,
      v_test,
      v_s1, v_s2
    from (
      select
        count(*) > 0 as has_any,
        bool_or(r.shift = 'morning') as has_morning,
        bool_or(r.shift = 'afternoon') as has_afternoon,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as o11_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as o11_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as o12_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as o12_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as o21_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as o21_a,
        max(r.opening_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as o22_m,
        max(r.opening_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as o22_a,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 1) as c11_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 1) as c11_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 1 and r.nozzle_no = 2) as c12_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 1 and r.nozzle_no = 2) as c12_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 1) as c21_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 1) as c21_m,
        max(r.closing_meter) filter (where r.shift = 'afternoon' and r.pump_no = 2 and r.nozzle_no = 2) as c22_a,
        max(r.closing_meter) filter (where r.shift = 'morning' and r.pump_no = 2 and r.nozzle_no = 2) as c22_m,
        coalesce(sum(r.testing_litres), 0) as testing,
        coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 1), 0) as s1,
        coalesce(sum(greatest(r.closing_meter - r.opening_meter, 0)) filter (where r.pump_no = 2), 0) as s2
      from public.meter_shift_readings r
      where r.reading_date = p_date
        and r.product = v_product
        and r.pump_no in (1, 2)
        and r.nozzle_no in (1, 2)
    ) q;

    if not coalesce(v_has_any, false) then
      v_result := v_result || jsonb_build_object(
        v_product,
        jsonb_build_object(
          'has_shifts', false,
          'has_morning', false,
          'has_afternoon', false
        )
      );
      continue;
    end if;

    v_c11 := coalesce(v_c11, v_o11);
    v_c12 := coalesce(v_c12, v_o12);
    v_c21 := coalesce(v_c21, v_o21);
    v_c22 := coalesce(v_c22, v_o22);
    v_s1 := coalesce(v_s1, 0);
    v_s2 := coalesce(v_s2, 0);
    v_test := coalesce(v_test, 0);

    v_result := v_result || jsonb_build_object(
      v_product,
      jsonb_build_object(
        'has_shifts', true,
        'has_morning', coalesce(v_has_morning, false),
        'has_afternoon', coalesce(v_has_afternoon, false),
        'opening_pump1_nozzle1', v_o11,
        'opening_pump1_nozzle2', v_o12,
        'opening_pump2_nozzle1', v_o21,
        'opening_pump2_nozzle2', v_o22,
        'closing_pump1_nozzle1', v_c11,
        'closing_pump1_nozzle2', v_c12,
        'closing_pump2_nozzle1', v_c21,
        'closing_pump2_nozzle2', v_c22,
        'sales_pump1', v_s1,
        'sales_pump2', v_s2,
        'total_sales', v_s1 + v_s2,
        'testing', v_test
      )
    );
  end loop;

  return v_result;
end;
$$;

comment on function public.get_shift_aggregated_daily_meters(date) is
  'Read-only shift rollup for meter form prefill. Entered nozzles only; never writes dsr_*.';

grant execute on function public.get_shift_aggregated_daily_meters(date) to authenticated;
