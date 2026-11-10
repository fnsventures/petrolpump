-- Canonical definition of public.recascade_day_closing_short_from. Edit here, then:
--   node scripts/sql-functions.mjs emit recascade_day_closing_short_from
create or replace function public.recascade_day_closing_short_from(p_from_date date)
returns void
language plpgsql security definer
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
begin
  for v_row in
    select date, night_cash, phone_pay, certified,
           total_sale, collection, short_previous, credit_today, expenses_today, short_today
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    if coalesce(v_row.certified, false) then
      continue;
    end if;

    v_components := public.compute_day_closing_components(v_row.date);
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
    v_short_today := (v_total_sale + v_collection + v_short_previous)
      - (v_row.night_cash + v_row.phone_pay + v_credit_today + v_expenses_today);

    -- Columns are numeric(14,2) and round on store; compare at that scale.
    if v_row.total_sale is not distinct from round(v_total_sale, 2)
       and v_row.collection is not distinct from round(v_collection, 2)
       and v_row.short_previous is not distinct from round(v_short_previous, 2)
       and v_row.credit_today is not distinct from round(v_credit_today, 2)
       and v_row.expenses_today is not distinct from round(v_expenses_today, 2)
       and v_row.short_today is not distinct from round(v_short_today, 2)
    then
      continue;
    end if;

    update public.day_closing set
      total_sale = v_total_sale,
      collection = v_collection,
      short_previous = v_short_previous,
      credit_today = v_credit_today,
      expenses_today = v_expenses_today,
      short_today = v_short_today
    where date = v_row.date;
  end loop;
end;
$$;

comment on function public.recascade_day_closing_short_from(date) is
  'After a day closing overwrite, recalculate short chain for later uncertified dates. Certified later days stay frozen. Days whose totals are unchanged are not rewritten.';

grant execute on function public.recascade_day_closing_short_from(date) to service_role;

revoke all on function public.recascade_day_closing_short_from(date) from public;

revoke all on function public.recascade_day_closing_short_from(date) from authenticated;
