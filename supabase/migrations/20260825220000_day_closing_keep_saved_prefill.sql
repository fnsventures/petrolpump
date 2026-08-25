-- Keep registered night_cash / phone_pay when a day closing already exists.
-- Suggested (shift + Cash/UPI settles) stays in suggested_* only — never replace
-- historical saved amounts in the form prefill (admins were seeing wrong PhonePe).

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
  'Day closing breakdown. suggested_* = shift + Cash/UPI settles; night_cash/phone_pay = saved when already registered, else suggested.';

grant execute on function public.get_day_closing_breakdown(date) to authenticated;
