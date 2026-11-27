-- Breakdown always uses live expense sum (matches expense detail list).
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_already_saved boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_live numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
begin
  select coalesce(sum(amount), 0) into v_expenses_live
  from public.expenses where date = p_date;

  select total_sale, collection, short_previous, credit_today, expenses_today,
         night_cash, phone_pay, short_today, closing_reference, remarks
  into v_existing
  from public.day_closing where date = p_date limit 1;
  v_already_saved := found;
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null;

  if v_use_snapshot then
    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
  else
    v_components := public.compute_day_closing_components(p_date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_live,
    'night_cash', case when v_already_saved then coalesce(v_existing.night_cash, 0) else null end,
    'phone_pay', case when v_already_saved then coalesce(v_existing.phone_pay, 0) else null end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved
  );
end;
$$;
