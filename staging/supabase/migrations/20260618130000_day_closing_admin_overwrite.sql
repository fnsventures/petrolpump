-- Admin can overwrite an existing day closing with updated snapshot values.
-- Subsequent closed days get short_previous / short_today recalculated.

create or replace function public.recascade_day_closing_short_from(p_from_date date)
returns void
language plpgsql security definer
as $$
declare
  v_row record;
  v_components jsonb;
  v_short_today numeric;
begin
  for v_row in
    select date, night_cash, phone_pay
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    v_components := public.compute_day_closing_components(v_row.date);
    v_short_today := (
      coalesce((v_components->>'total_sale')::numeric, 0)
      + coalesce((v_components->>'collection')::numeric, 0)
      + coalesce((v_components->>'short_previous')::numeric, 0)
    ) - (
      v_row.night_cash + v_row.phone_pay
      + coalesce((v_components->>'credit_today')::numeric, 0)
      + coalesce((v_components->>'expenses_today')::numeric, 0)
    );

    update public.day_closing set
      total_sale = coalesce((v_components->>'total_sale')::numeric, 0),
      collection = coalesce((v_components->>'collection')::numeric, 0),
      short_previous = coalesce((v_components->>'short_previous')::numeric, 0),
      credit_today = coalesce((v_components->>'credit_today')::numeric, 0),
      expenses_today = coalesce((v_components->>'expenses_today')::numeric, 0),
      short_today = v_short_today
    where date = v_row.date;
  end loop;
end;
$$;

comment on function public.recascade_day_closing_short_from(date) is
  'After a day closing overwrite, recalculate short chain for all later closed dates.';

create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
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
  v_can_overwrite := v_already_saved and public.is_admin();
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

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
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite
  );
end;
$$;

comment on function public.get_day_closing_breakdown(date) is
  'Returns day closing components. Snapshot for saved days; admins see live values and can_overwrite.';

create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_components jsonb;
  v_existing record;
  v_is_overwrite boolean := false;
  v_total_sale numeric;
  v_collection numeric;
  v_short_previous numeric;
  v_credit_today numeric;
  v_expenses_today numeric;
  v_short_today numeric;
  v_ref text;
  v_seq bigint;
begin
  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  select closing_reference into v_existing
  from public.day_closing where date = p_date;
  if found then
    if not public.is_admin() then
      raise exception 'Day closing already saved for this date.';
    end if;
    v_is_overwrite := true;
    v_ref := v_existing.closing_reference;
  end if;

  v_components := public.compute_day_closing_components(p_date);
  v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
  v_collection := coalesce((v_components->>'collection')::numeric, 0);
  v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
  v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
  v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);

  v_short_today := (v_total_sale + v_collection + v_short_previous)
    - (p_night_cash + p_phone_pay + v_credit_today + v_expenses_today);

  if v_is_overwrite then
    update public.day_closing set
      night_cash = p_night_cash,
      phone_pay = p_phone_pay,
      short_today = v_short_today,
      total_sale = v_total_sale,
      collection = v_collection,
      short_previous = v_short_previous,
      credit_today = v_credit_today,
      expenses_today = v_expenses_today,
      remarks = nullif(trim(p_remarks), '')
    where date = p_date;

    perform public.recascade_day_closing_short_from(p_date);
  else
    select coalesce(max(
      nullif(regexp_replace(closing_reference, '^DC-[0-9]+-([0-9]+)$', '\1'), '')::bigint
    ), 0) + 1 into v_seq
    from public.day_closing
    where extract(year from date) = extract(year from p_date)
      and closing_reference is not null
      and closing_reference ~ '^DC-[0-9]+-[0-9]+$';
    v_ref := 'DC-' || to_char(p_date, 'YYYY') || '-' || lpad(v_seq::text, 5, '0');

    insert into public.day_closing (
      date, night_cash, phone_pay, short_today,
      total_sale, collection, short_previous, credit_today, expenses_today,
      closing_reference, remarks, created_by
    )
    values (
      p_date, p_night_cash, p_phone_pay, v_short_today,
      v_total_sale, v_collection, v_short_previous, v_credit_today, v_expenses_today,
      v_ref, nullif(trim(p_remarks), ''), auth.uid()
    );
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_today, 0),
    'expenses_today', coalesce(v_expenses_today, 0),
    'night_cash', coalesce(p_night_cash, 0),
    'phone_pay', coalesce(p_phone_pay, 0),
    'short_today', coalesce(v_short_today, 0),
    'closing_reference', v_ref,
    'remarks', nullif(trim(p_remarks), ''),
    'overwritten', v_is_overwrite
  );
end;
$$;

comment on function public.save_day_closing(date, numeric, numeric, text) is
  'Save day closing with full statement snapshot. Admins can overwrite an existing closing for the same date.';

grant execute on function public.recascade_day_closing_short_from(date) to authenticated;
