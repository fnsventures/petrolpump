-- Canonical definition of public.day_closing_block_collected_mutation. Edit here, then:
--   node scripts/sql-functions.mjs emit day_closing_block_collected_mutation
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
