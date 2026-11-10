-- Canonical definition of public.apply_credit_payment_to_day_closing. Edit here, then:
--   node scripts/sql-functions.mjs emit apply_credit_payment_to_day_closing
create or replace function public.apply_credit_payment_to_day_closing(
  p_date date,
  p_same_day_settlement boolean default false,
  p_payment_mode text default 'Cash',
  p_amount numeric default 0
)
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
  v_night_cash numeric;
  v_phone_pay numeric;
  v_short_today numeric;
  v_mode text;
begin
  if p_date is null then
    return;
  end if;

  select
    night_cash, phone_pay, total_sale, collection, short_previous, credit_today,
    expenses_today, short_today, night_cash_collection_id, certified
  into v_row
  from public.day_closing
  where date = p_date
  limit 1;

  if not found then
    return;
  end if;

  perform public.raise_if_day_closing_certified(p_date);

  if v_row.night_cash_collection_id is not null and not public.is_admin() then
    return;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_night_cash := coalesce(v_row.night_cash, 0);
  v_phone_pay := coalesce(v_row.phone_pay, 0);

  if coalesce(p_same_day_settlement, false) and coalesce(p_amount, 0) <> 0
     and v_row.night_cash_collection_id is null then
    v_mode := lower(trim(coalesce(p_payment_mode, 'Cash')));
    if v_mode = 'upi' then
      v_phone_pay := greatest(0, v_phone_pay + p_amount);
    elsif v_mode = 'bank' then
      null;
    else
      v_night_cash := greatest(0, v_night_cash + p_amount);
    end if;
  end if;

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (v_night_cash + v_phone_pay + v_credit_today + v_expenses_today);

  update public.day_closing set
    total_sale = v_total_sale,
    collection = v_collection,
    short_previous = v_short_previous,
    credit_today = v_credit_today,
    expenses_today = v_expenses_today,
    night_cash = v_night_cash,
    phone_pay = v_phone_pay,
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) is
  'After a credit payment: refresh day_closing. Certified dates are rejected until revoke.';

revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from public;

revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from authenticated;
