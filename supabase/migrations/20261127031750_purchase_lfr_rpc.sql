-- Purchase cost: save the shared LFR invoice for a receipt day on its own (both products),
-- independent of the per-product buying price / delivery save.

-- From supabase/functions-sql/update_dsr_purchase_lfr.sql
create or replace function public.update_dsr_purchase_lfr(
  p_date date,
  p_lfr_total numeric,
  p_lfr_qty_kl numeric,
  p_lfr_per_kl numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_petrol int := 0;
  v_diesel int := 0;
begin
  if not public.is_admin() then
    raise exception 'Admin access required to set LFR';
  end if;
  if p_date is null then
    raise exception 'Receipt date is required';
  end if;
  if p_lfr_total is null or p_lfr_total < 0 then
    raise exception 'LFR taxable amount must be 0 or more';
  end if;
  if p_lfr_qty_kl is null or p_lfr_qty_kl <= 0 then
    raise exception 'LFR quantity (KL) must be greater than 0';
  end if;
  if p_lfr_per_kl is null or p_lfr_per_kl < 0 then
    raise exception 'LFR per KL must be 0 or more';
  end if;

  update public.dsr_petrol
  set
    purchase_lfr_per_kl = p_lfr_per_kl,
    purchase_lfr_total = p_lfr_total,
    purchase_lfr_qty_kl = p_lfr_qty_kl
  where date = p_date and receipts > 0;
  get diagnostics v_petrol = row_count;

  update public.dsr_diesel
  set
    purchase_lfr_per_kl = p_lfr_per_kl,
    purchase_lfr_total = p_lfr_total,
    purchase_lfr_qty_kl = p_lfr_qty_kl
  where date = p_date and receipts > 0;
  get diagnostics v_diesel = row_count;

  if v_petrol + v_diesel = 0 then
    raise exception 'No fuel receipt on %', p_date;
  end if;

  return jsonb_build_object('date', p_date, 'petrol', v_petrol > 0, 'diesel', v_diesel > 0);
end;
$$;

comment on function public.update_dsr_purchase_lfr(date, numeric, numeric, numeric) is
  'Admin-only: set the shared LFR (taxable total, KL, per-KL incl. GST) on every dsr_petrol / dsr_diesel receipt row for a date, without touching buying price or delivery. Meter trigger rejects a certified day.';

revoke all on function public.update_dsr_purchase_lfr(date, numeric, numeric, numeric) from public, anon;

grant execute on function public.update_dsr_purchase_lfr(date, numeric, numeric, numeric) to authenticated;
