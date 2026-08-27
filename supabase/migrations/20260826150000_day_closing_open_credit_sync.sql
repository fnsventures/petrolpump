-- Shift register keeps gross credit for shift short.
-- Day closing Credit today = open credit only (same-day settled excluded).
-- After payment: refresh saved day closing so Register matches Close day;
-- same-day Cash/UPI also moves into night_cash / phone_pay so short stays balanced.

-- ─── 1) compute: expose gross shift credit; credit_today stays net open ─────
create or replace function public.compute_day_closing_components(p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_ledger numeric := 0;
  v_credit_shift numeric := 0;
  v_credit_shift_gross numeric := 0;
  v_expenses_ledger numeric := 0;
  v_expenses_shift numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_same_day_settle numeric := 0;
  v_same_day_cash numeric := 0;
  v_same_day_upi numeric := 0;
  v_same_day_bank numeric := 0;
  v_payments_raw numeric := 0;
  v_credit_entries numeric := 0;
  v_credit_legacy numeric := 0;
  v_pay_cash numeric := 0;
  v_pay_upi numeric := 0;
  v_same_day_credit_reduce numeric := 0;
  v_open_credit numeric := 0;
begin
  perform public.require_staff_access();

  select coalesce(sum(
    coalesce(v_row.total_sales, 0)
    * case
        when v_row.product = 'petrol' then coalesce(v_row.petrol_rate, 0)
        when v_row.product = 'diesel' then coalesce(v_row.diesel_rate, 0)
        else 0
      end
  ), 0) into v_total_sale
  from (
    select distinct on (product)
      product, total_sales, petrol_rate, diesel_rate
    from public.dsr
    where date = p_date
    order by product, created_at desc nulls last, id desc
  ) v_row;

  with pay as (
    select
      credit_customer_id,
      sum(amount) as pay_today,
      sum(amount) filter (where coalesce(same_day_settlement, false)) as same_day_pay,
      sum(amount) filter (where not coalesce(same_day_settlement, false)) as collection_pay,
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as pay_cash,
      sum(amount) filter (
        where lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as pay_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, 'Cash'))) = 'cash'
      ) as same_day_cash,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'upi'
      ) as same_day_upi,
      sum(amount) filter (
        where coalesce(same_day_settlement, false)
          and lower(trim(coalesce(payment_mode, ''))) = 'bank'
      ) as same_day_bank
    from public.credit_payments
    where date = p_date
    group by credit_customer_id
  ),
  cred as (
    select
      credit_customer_id,
      sum(amount) as credit_today,
      sum(amount) filter (
        where employee_id is not null and shift is not null
      ) as credit_shift
    from public.credit_entries
    where transaction_date = p_date
    group by credit_customer_id
  ),
  split as (
    select
      coalesce(p.pay_today, 0) as pay_today,
      coalesce(p.collection_pay, 0) as collection_pay,
      coalesce(p.same_day_pay, 0) as same_day_pay,
      coalesce(p.pay_cash, 0) as pay_cash,
      coalesce(p.pay_upi, 0) as pay_upi,
      coalesce(p.same_day_cash, 0) as same_day_cash,
      coalesce(p.same_day_upi, 0) as same_day_upi,
      coalesce(p.same_day_bank, 0) as same_day_bank,
      coalesce(c.credit_today, 0) as credit_today,
      coalesce(c.credit_shift, 0) as credit_shift,
      least(coalesce(p.same_day_pay, 0), coalesce(c.credit_today, 0)) as same_day_credit_reduce
    from pay p
    full outer join cred c using (credit_customer_id)
  )
  select
    coalesce(sum(pay_today), 0),
    coalesce(sum(collection_pay), 0),
    coalesce(sum(pay_cash), 0),
    coalesce(sum(pay_upi), 0),
    coalesce(sum(credit_today), 0),
    coalesce(sum(credit_shift), 0),
    coalesce(sum(same_day_pay), 0),
    coalesce(sum(same_day_cash), 0),
    coalesce(sum(same_day_upi), 0),
    coalesce(sum(same_day_bank), 0),
    coalesce(sum(same_day_credit_reduce), 0)
  into
    v_payments_raw, v_collection,
    v_pay_cash, v_pay_upi,
    v_credit_entries, v_credit_shift_gross,
    v_same_day_settle, v_same_day_cash, v_same_day_upi, v_same_day_bank,
    v_same_day_credit_reduce
  from split;

  select coalesce(sum(c.amount_due), 0) into v_credit_legacy
  from public.credit_customers c
  where c.date = p_date
    and not exists (
      select 1 from public.credit_entries e where e.credit_customer_id = c.id
    );

  -- Day closing Credit today = open credit only (same-day settled removed).
  v_open_credit := greatest(v_credit_entries - v_same_day_credit_reduce, 0);
  v_credit_ledger := v_open_credit + v_credit_legacy;

  select short_today into v_short_previous
  from public.day_closing where date = p_date - interval '1 day' limit 1;
  v_short_previous := coalesce(v_short_previous, 0);

  -- Open shift-attributed credit only (for Credit today breakdown).
  -- Gross shift credit stays on meter_shift_cash for shift short.
  v_credit_shift := least(v_credit_shift_gross, v_open_credit);

  select coalesce(sum(amount), 0) into v_expenses_ledger
  from public.expenses where date = p_date;

  select coalesce(sum(amount), 0) into v_expenses_shift
  from public.expenses
  where date = p_date and employee_id is not null and shift is not null;

  select
    coalesce(sum(cash_collected), 0),
    coalesce(sum(phone_pay), 0)
  into v_shift_cash, v_shift_phone
  from public.meter_shift_cash
  where reading_date = p_date;

  return jsonb_build_object(
    'total_sale', coalesce(v_total_sale, 0),
    'collection', coalesce(v_collection, 0),
    'short_previous', coalesce(v_short_previous, 0),
    'credit_today', coalesce(v_credit_ledger, 0),
    'expenses_today', coalesce(v_expenses_ledger, 0),
    'credit_ledger', coalesce(v_credit_ledger, 0) - coalesce(v_credit_shift, 0),
    'credit_shift', coalesce(v_credit_shift, 0),
    'credit_shift_gross', coalesce(v_credit_shift_gross, 0),
    'expenses_ledger', coalesce(v_expenses_ledger, 0) - coalesce(v_expenses_shift, 0),
    'expenses_shift', coalesce(v_expenses_shift, 0),
    'shift_cash_total', coalesce(v_shift_cash, 0),
    'shift_phone_pay_total', coalesce(v_shift_phone, 0),
    'same_day_settle', coalesce(v_same_day_settle, 0),
    'same_day_settle_cash', coalesce(v_same_day_cash, 0),
    'same_day_settle_upi', coalesce(v_same_day_upi, 0),
    'same_day_settle_bank', coalesce(v_same_day_bank, 0),
    'settle_cash_total', coalesce(v_pay_cash, 0),
    'settle_upi_total', coalesce(v_pay_upi, 0),
    'suggested_night_cash', coalesce(v_shift_cash, 0) + coalesce(v_pay_cash, 0),
    'suggested_phone_pay', coalesce(v_shift_phone, 0) + coalesce(v_pay_upi, 0)
  );
end;
$$;

comment on function public.compute_day_closing_components(date) is
  'Day closing: credit_today = open credit (same-day settled excluded). credit_shift_gross = shift register credit for shift short.';

-- ─── 2) Sync helper after credit payment ───────────────────────────────────
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
  v_locked boolean := false;
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

  v_locked := (v_row.night_cash_collection_id is not null) or coalesce(v_row.certified, false);
  if v_locked and not public.is_admin() then
    -- Supervisors cannot mutate locked closings; live breakdown still nets credit.
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

  -- Same-day settle moves money from Credit today into Night cash / Phone pay.
  -- Keep short balanced and Register aligned with Close day.
  if coalesce(p_same_day_settlement, false) and coalesce(p_amount, 0) > 0
     and v_row.night_cash_collection_id is null then
    v_mode := lower(trim(coalesce(p_payment_mode, 'Cash')));
    if v_mode = 'upi' then
      v_phone_pay := v_phone_pay + p_amount;
    elsif v_mode = 'bank' then
      null; -- bank leaves the pump; credit drops, short improves
    else
      v_night_cash := v_night_cash + p_amount;
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
    short_today = v_short_today,
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) is
  'After a credit payment: refresh day_closing open credit; same-day Cash/UPI bumps night_cash/phone_pay.';

revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from public;
revoke all on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) from authenticated;

-- ─── 3) Wire into record_credit_payment ────────────────────────────────────
create or replace function public.record_credit_payment(
  p_credit_customer_id uuid,
  p_date date,
  p_amount numeric,
  p_note text default null,
  p_payment_mode text default 'Cash',
  p_same_day_settlement boolean default false
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_remaining numeric := p_amount;
  v_entry record;
  v_alloc numeric;
  v_new_due numeric;
  v_prepaid numeric;
begin
  perform public.require_staff_access();

  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_date > current_date then
    raise exception 'payment date cannot be in the future';
  end if;
  if p_payment_mode is not null and p_payment_mode not in ('Cash', 'UPI', 'Bank') then
    raise exception 'payment_mode must be Cash, UPI, or Bank';
  end if;

  if not exists (select 1 from public.credit_customers where id = p_credit_customer_id) then
    raise exception 'Credit customer not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    for v_entry in
      select id, amount, amount_settled
      from public.credit_entries
      where credit_customer_id = p_credit_customer_id
        and amount_settled < amount
        and transaction_date <= p_date
      order by transaction_date desc, id desc
      for update
    loop
      exit when v_remaining <= 0;
      v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
      update public.credit_entries
      set amount_settled = amount_settled + v_alloc
      where id = v_entry.id;
      v_remaining := v_remaining - v_alloc;
    end loop;

    insert into public.credit_payments (
      credit_customer_id, date, amount, note, payment_mode, same_day_settlement, created_by
    )
    values (
      p_credit_customer_id,
      p_date,
      p_amount,
      nullif(trim(p_note), ''),
      coalesce(p_payment_mode, 'Cash'),
      coalesce(p_same_day_settlement, false),
      auth.uid()
    );

    perform public.sync_credit_customer_balances(p_credit_customer_id);

    update public.credit_customers
    set last_payment = p_date
    where id = p_credit_customer_id;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  -- Keep day closing / register in sync with open credit (and same-day cash routing).
  perform public.apply_credit_payment_to_day_closing(
    p_date,
    coalesce(p_same_day_settlement, false),
    coalesce(p_payment_mode, 'Cash'),
    p_amount
  );

  select amount_due, prepaid_balance into v_new_due, v_prepaid
  from public.credit_customers
  where id = p_credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', p_credit_customer_id,
    'date', p_date,
    'amount', p_amount,
    'same_day_settlement', coalesce(p_same_day_settlement, false),
    'new_due', v_new_due,
    'prepaid_balance', v_prepaid,
    'net_balance', v_new_due - v_prepaid
  );
end;
$$;

comment on function public.record_credit_payment(uuid, date, numeric, text, text, boolean) is
  'Record payment. Same-day flag excludes from Collection and nets Credit today; syncs day closing.';

-- ─── 4) Pass credit_shift_gross through breakdown RPC ─────────────────────────
create or replace function public.get_day_closing_breakdown(p_date date)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_components jsonb;
  v_existing record;
  v_collection_ref text;
  v_already_saved boolean := false;
  v_can_overwrite boolean := false;
  v_night_cash_collected boolean := false;
  v_certified boolean := false;
  v_use_snapshot boolean := false;
  v_expenses_today numeric := 0;
  v_total_sale numeric := 0;
  v_collection numeric := 0;
  v_short_previous numeric := 0;
  v_credit_today numeric := 0;
  v_shift_cash numeric := 0;
  v_shift_phone numeric := 0;
  v_settle_cash numeric := 0;
  v_settle_upi numeric := 0;
  v_suggested_cash numeric := 0;
  v_suggested_phone numeric := 0;
  v_saved_cash numeric := null;
  v_saved_phone numeric := null;
begin
  perform public.require_staff_access();

  select dc.total_sale, dc.collection, dc.short_previous, dc.credit_today, dc.expenses_today,
         dc.night_cash, dc.phone_pay, dc.short_today, dc.closing_reference, dc.remarks,
         dc.certified, dc.certified_at, dc.certified_by_name,
         dc.night_cash_collection_id, ncc.collection_reference
  into v_existing
  from public.day_closing dc
  left join public.night_cash_collections ncc on ncc.id = dc.night_cash_collection_id
  where dc.date = p_date
  limit 1;

  v_already_saved := found;
  v_night_cash_collected := v_already_saved and v_existing.night_cash_collection_id is not null;
  v_certified := v_already_saved and coalesce(v_existing.certified, false);
  v_collection_ref := v_existing.collection_reference;
  v_can_overwrite := v_already_saved and (
    public.is_admin()
    or (not v_night_cash_collected and not v_certified)
  );
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  v_components := public.compute_day_closing_components(p_date);
  v_shift_cash := coalesce((v_components->>'shift_cash_total')::numeric, 0);
  v_shift_phone := coalesce((v_components->>'shift_phone_pay_total')::numeric, 0);
  v_settle_cash := coalesce((v_components->>'settle_cash_total')::numeric, 0);
  v_settle_upi := coalesce((v_components->>'settle_upi_total')::numeric, 0);
  v_suggested_cash := v_shift_cash + v_settle_cash;
  v_suggested_phone := v_shift_phone + v_settle_upi;

  if v_already_saved then
    v_saved_cash := coalesce(v_existing.night_cash, 0);
    v_saved_phone := coalesce(v_existing.phone_pay, 0);
  end if;

  if v_use_snapshot then
    v_total_sale := coalesce(v_existing.total_sale, 0);
    v_collection := coalesce(v_existing.collection, 0);
    v_short_previous := coalesce(v_existing.short_previous, 0);
    v_credit_today := coalesce(v_existing.credit_today, 0);
    v_expenses_today := coalesce(v_existing.expenses_today, 0);
  else
    v_total_sale := coalesce((v_components->>'total_sale')::numeric, 0);
    v_collection := coalesce((v_components->>'collection')::numeric, 0);
    v_short_previous := coalesce((v_components->>'short_previous')::numeric, 0);
    v_credit_today := coalesce((v_components->>'credit_today')::numeric, 0);
    v_expenses_today := coalesce((v_components->>'expenses_today')::numeric, 0);
  end if;

  return jsonb_build_object(
    'date', p_date,
    'total_sale', v_total_sale,
    'collection', v_collection,
    'short_previous', v_short_previous,
    'credit_today', v_credit_today,
    'expenses_today', v_expenses_today,
    'credit_ledger', coalesce((v_components->>'credit_ledger')::numeric, 0),
    'credit_shift', coalesce((v_components->>'credit_shift')::numeric, 0),
    'credit_shift_gross', coalesce((v_components->>'credit_shift_gross')::numeric, 0),
    'expenses_ledger', coalesce((v_components->>'expenses_ledger')::numeric, 0),
    'expenses_shift', coalesce((v_components->>'expenses_shift')::numeric, 0),
    'shift_cash_total', v_shift_cash,
    'shift_phone_pay_total', v_shift_phone,
    'same_day_settle', coalesce((v_components->>'same_day_settle')::numeric, 0),
    'same_day_settle_cash', coalesce((v_components->>'same_day_settle_cash')::numeric, 0),
    'same_day_settle_upi', coalesce((v_components->>'same_day_settle_upi')::numeric, 0),
    'same_day_settle_bank', coalesce((v_components->>'same_day_settle_bank')::numeric, 0),
    'settle_cash_total', v_settle_cash,
    'settle_upi_total', v_settle_upi,
    'suggested_night_cash', v_suggested_cash,
    'suggested_phone_pay', v_suggested_phone,
    'saved_night_cash', v_saved_cash,
    'saved_phone_pay', v_saved_phone,
    'snapshot', v_use_snapshot,
    'night_cash', case
      when v_already_saved then v_saved_cash
      else v_suggested_cash
    end,
    'phone_pay', case
      when v_already_saved then v_saved_phone
      else v_suggested_phone
    end,
    'short_today', case when v_already_saved then coalesce(v_existing.short_today, 0) else null end,
    'closing_reference', case when v_already_saved then v_existing.closing_reference else null end,
    'remarks', case when v_already_saved then v_existing.remarks else null end,
    'already_saved', v_already_saved,
    'can_overwrite', v_can_overwrite,
    'night_cash_collected', v_night_cash_collected,
    'night_cash_collection_reference', v_collection_ref,
    'certified', v_certified,
    'certified_at', case when v_certified then v_existing.certified_at else null end,
    'certified_by_name', case when v_certified then v_existing.certified_by_name else null end,
    'can_certify', v_already_saved and not v_certified and public.is_admin()
  );
end;
$$;
