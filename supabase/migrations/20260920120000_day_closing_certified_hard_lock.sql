-- Certified day closing is a hard lock for everyone, including admin.
-- Edits require an explicit revoke; recertify writes a new name + timestamp.
-- Night-cash collection may still link a certified row (pickup, not a figure change).

create or replace function public.raise_if_day_closing_certified(p_date date)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_date is null then
    return;
  end if;
  if exists (
    select 1
    from public.day_closing
    where date = p_date
      and coalesce(certified, false)
  ) then
    raise exception
      'Day closing for % is certified and locked. Revoke certification before changing it.',
      p_date;
  end if;
end;
$$;

comment on function public.raise_if_day_closing_certified(date) is
  'Raise when the date''s day closing is certified. Used by save/sync/delete paths.';

revoke all on function public.raise_if_day_closing_certified(date) from public;
revoke all on function public.raise_if_day_closing_certified(date) from authenticated;

comment on column public.day_closing.certified is
  'True after an admin acknowledges the saved statement. While true, figures are frozen for everyone until revoke.';
comment on column public.day_closing.night_cash_collection_id is
  'When set, night cash was collected. Supervisors cannot edit; admins may still modify unless the closing is certified.';

-- ─── RLS: certified rows are not updatable via the table; RPCs are security definer ─
drop policy if exists "day_closing_update_by_role" on public.day_closing;
create policy "day_closing_update_by_role" on public.day_closing
  for update to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and night_cash_collection_id is null
    and certified = false
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
    and night_cash_collection_id is null
    and certified = false
  );

drop policy if exists "day_closing_delete_admin" on public.day_closing;
create policy "day_closing_delete_admin" on public.day_closing
  for delete to authenticated
  using (
    public.is_admin()
    and night_cash_collection_id is null
    and certified = false
  );

-- ─── Trigger: certified rows may only be revoked or linked to a night-cash pickup ─
create or replace function public.day_closing_block_collected_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(old.certified, false) then
      raise exception
        'Day closing for % is certified and locked. Revoke certification before deleting it.',
        old.date;
    end if;
    if old.night_cash_collection_id is not null then
      raise exception
        'Day closing for % is locked: night cash was collected. Remove the collection in the database first.',
        old.date;
    end if;
    return old;
  end if;

  if coalesce(old.certified, false) then
    -- Revoke: only certification columns may change.
    if not coalesce(new.certified, false) then
      if new.night_cash is distinct from old.night_cash
         or new.phone_pay is distinct from old.phone_pay
         or new.short_today is distinct from old.short_today
         or new.total_sale is distinct from old.total_sale
         or new.collection is distinct from old.collection
         or new.short_previous is distinct from old.short_previous
         or new.credit_today is distinct from old.credit_today
         or new.expenses_today is distinct from old.expenses_today
         or new.remarks is distinct from old.remarks
         or new.closing_reference is distinct from old.closing_reference
         or new.night_cash_collection_id is distinct from old.night_cash_collection_id
      then
        raise exception
          'Day closing for % is certified and locked. Revoke certification before changing it.',
          old.date;
      end if;
      return new;
    end if;

    -- Stay certified: allow night-cash collection link only.
    if new.night_cash is distinct from old.night_cash
       or new.phone_pay is distinct from old.phone_pay
       or new.short_today is distinct from old.short_today
       or new.total_sale is distinct from old.total_sale
       or new.collection is distinct from old.collection
       or new.short_previous is distinct from old.short_previous
       or new.credit_today is distinct from old.credit_today
       or new.expenses_today is distinct from old.expenses_today
       or new.remarks is distinct from old.remarks
       or new.closing_reference is distinct from old.closing_reference
       or new.certified_at is distinct from old.certified_at
       or new.certified_by is distinct from old.certified_by
       or new.certified_by_name is distinct from old.certified_by_name
    then
      raise exception
        'Day closing for % is certified and locked. Revoke certification before changing it.',
        old.date;
    end if;
  end if;

  if old.night_cash_collection_id is not null then
    if not public.is_admin() then
      raise exception
        'Day closing for % is locked: night cash was collected (ref %). Only an admin can modify it.',
        old.date,
        (select collection_reference from public.night_cash_collections where id = old.night_cash_collection_id);
    end if;
    if new.night_cash_collection_id is distinct from old.night_cash_collection_id then
      raise exception 'Cannot change night cash collection link on a collected day closing.';
    end if;
  end if;

  return new;
end;
$$;

-- ─── Breakdown: certified ⇒ can_overwrite false even for admin (frozen snapshot) ─
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
  v_can_overwrite := v_already_saved and not v_certified and (
    public.is_admin()
    or not v_night_cash_collected
  );
  v_use_snapshot := v_already_saved and v_existing.total_sale is not null and not v_can_overwrite;

  v_components := public.compute_day_closing_components(p_date);
  v_shift_cash := coalesce((v_components->>'shift_cash_total')::numeric, 0);
  v_shift_phone := coalesce((v_components->>'shift_phone_pay_total')::numeric, 0);
  v_settle_cash := coalesce((v_components->>'settle_cash_total')::numeric, 0);
  v_settle_upi := coalesce((v_components->>'settle_upi_total')::numeric, 0);
  -- Authoritative suggestion: always shift + settles (ignore stale keys)
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
    -- Already saved: always return registered amounts. Suggestions stay in suggested_*.
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

comment on function public.get_day_closing_breakdown(date) is
  'Day closing breakdown. Certified days return the frozen snapshot; can_overwrite is false for everyone until revoke.';

-- ─── Save: reject certified rows instead of auto-uncertifying ─
create or replace function public.save_day_closing(
  p_date date,
  p_night_cash numeric,
  p_phone_pay numeric,
  p_remarks text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
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
  perform public.require_staff_access();

  if p_night_cash is null or p_night_cash < 0 then
    raise exception 'night_cash must be >= 0';
  end if;
  if p_phone_pay is null or p_phone_pay < 0 then
    raise exception 'phone_pay must be >= 0';
  end if;

  select closing_reference, night_cash_collection_id, certified into v_existing
  from public.day_closing where date = p_date;
  if found then
    perform public.raise_if_day_closing_certified(p_date);
    if v_existing.night_cash_collection_id is not null and not public.is_admin() then
      raise exception 'Day closing for % is locked: night cash was collected. Only an admin can modify it.', p_date;
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
    'overwritten', v_is_overwrite,
    'certified', false
  );
end;
$$;

comment on function public.save_day_closing(date, numeric, numeric, text) is
  'Save or overwrite day closing. Certified rows are rejected until an admin revokes certification.';

comment on function public.set_day_closing_certified(date, boolean) is
  'Admin-only: certify a saved statement (locks figures) or revoke so it can be edited and acknowledged again.';

-- ─── Credit/sync must not mutate or silently uncertify a sealed statement ─
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

  if coalesce(p_same_day_settlement, false) and coalesce(p_amount, 0) > 0
     and v_row.night_cash_collection_id is null then
    v_mode := lower(trim(coalesce(p_payment_mode, 'Cash')));
    if v_mode = 'upi' then
      v_phone_pay := v_phone_pay + p_amount;
    elsif v_mode = 'bank' then
      null;
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
    short_today = v_short_today
  where date = p_date;

  perform public.recascade_day_closing_short_from(p_date);
end;
$$;

comment on function public.apply_credit_payment_to_day_closing(date, boolean, text, numeric) is
  'After a credit payment: refresh day_closing. Certified dates are rejected until revoke.';

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
    select date, night_cash, phone_pay, certified
    from public.day_closing
    where date > p_from_date
    order by date asc
  loop
    if coalesce(v_row.certified, false) then
      continue;
    end if;

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
  'After a day closing overwrite, recalculate short chain for later uncertified dates. Certified later days stay frozen.';

create or replace function public.delete_day_closing(p_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_row record;
  v_latest_date date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete day closing records';
  end if;

  select * into v_row from public.day_closing where id = p_id;
  if not found then
    raise exception 'Day closing record not found';
  end if;

  if coalesce(v_row.certified, false) then
    raise exception
      'Day closing for % is certified and locked. Revoke certification before deleting it.',
      v_row.date;
  end if;

  if v_row.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected.', v_row.date;
  end if;

  select max(date) into v_latest_date from public.day_closing;

  if v_row.date < v_latest_date then
    raise exception 'Only the most recent day closing can be deleted. Remove newer closings first.';
  end if;

  delete from public.day_closing where id = p_id;

  return jsonb_build_object(
    'date', v_row.date,
    'closing_reference', v_row.closing_reference
  );
end;
$$;

comment on function public.delete_day_closing(uuid) is
  'Admin-only: delete the latest uncertified day closing so the date can be re-closed.';
