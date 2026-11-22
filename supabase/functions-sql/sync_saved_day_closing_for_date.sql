-- Canonical definition of public.sync_saved_day_closing_for_date. Edit here, then:
--   node scripts/sql-functions.mjs emit sync_saved_day_closing_for_date
create or replace function public.sync_saved_day_closing_for_date(p_date date)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_row record;
  v_components jsonb;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_changed boolean := false;
begin
  select night_cash, phone_pay, total_sale, collection, short_previous, credit_today,
         expenses_today, short_today, certified
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (coalesce(v_row.night_cash, 0) + coalesce(v_row.phone_pay, 0) + v_credit_today + v_expenses_today);

  v_changed :=
    v_row.total_sale is distinct from v_total_sale
    or v_row.collection is distinct from v_collection
    or v_row.short_previous is distinct from v_short_previous
    or v_row.credit_today is distinct from v_credit_today
    or v_row.expenses_today is distinct from v_expenses_today
    or v_row.short_today is distinct from v_short_today;

  if not v_changed then
    return;
  end if;

  update public.day_closing set
    total_sale = v_total_sale,
    collection = v_collection,
    short_previous = v_short_previous,
    credit_today = v_credit_today,
    expenses_today = v_expenses_today,
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.sync_saved_day_closing_for_date(date) is
  'Refresh saved day_closing snapshot from live books. Certified dates are rejected until revoke.';

revoke all on function public.sync_saved_day_closing_for_date(date) from public;

revoke all on function public.sync_saved_day_closing_for_date(date) from authenticated;
