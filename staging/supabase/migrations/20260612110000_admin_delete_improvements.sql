-- Admin delete improvements: hardened credit RPCs, audit trail, safe day-closing delete

-- Harden FIFO re-allocation (skip per-row sync during bulk updates)
create or replace function public.reallocate_credit_settlements(p_credit_customer_id uuid)
returns void
language plpgsql
as $$
declare
  v_pay record;
  v_entry record;
  v_remaining numeric;
  v_alloc numeric;
begin
  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    update public.credit_entries
    set amount_settled = 0
    where credit_customer_id = p_credit_customer_id;

    for v_pay in
      select id, amount
      from public.credit_payments
      where credit_customer_id = p_credit_customer_id
      order by date asc, created_at asc, id asc
    loop
      v_remaining := v_pay.amount;
      for v_entry in
        select id, amount, amount_settled
        from public.credit_entries
        where credit_customer_id = p_credit_customer_id
          and amount_settled < amount
        order by transaction_date asc, id asc
        for update
      loop
        exit when v_remaining <= 0;
        v_alloc := least(v_remaining, v_entry.amount - v_entry.amount_settled);
        update public.credit_entries
        set amount_settled = amount_settled + v_alloc
        where id = v_entry.id;
        v_remaining := v_remaining - v_alloc;
      end loop;
    end loop;
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);
end;
$$;

-- Harden settlement delete with exception-safe skip_credit_sync
create or replace function public.delete_credit_payment(p_payment_id uuid)
returns jsonb
language plpgsql security definer
as $$
declare
  v_payment record;
  v_new_due numeric;
  v_last_payment date;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can delete credit settlements';
  end if;

  select * into v_payment
  from public.credit_payments
  where id = p_payment_id;

  if not found then
    raise exception 'Settlement record not found';
  end if;

  perform set_config('app.skip_credit_sync', 'true', true);

  begin
    delete from public.credit_payments where id = p_payment_id;
    perform public.reallocate_credit_settlements(v_payment.credit_customer_id);
  exception
    when others then
      perform set_config('app.skip_credit_sync', '', true);
      raise;
  end;

  perform set_config('app.skip_credit_sync', '', true);

  select coalesce(sum(amount - amount_settled), 0) into v_new_due
  from public.credit_entries
  where credit_customer_id = v_payment.credit_customer_id;

  select max(date) into v_last_payment
  from public.credit_payments
  where credit_customer_id = v_payment.credit_customer_id;

  update public.credit_customers
  set amount_due = v_new_due, last_payment = v_last_payment
  where id = v_payment.credit_customer_id;

  return jsonb_build_object(
    'credit_customer_id', v_payment.credit_customer_id,
    'deleted_amount', v_payment.amount,
    'deleted_date', v_payment.date,
    'new_due', v_new_due
  );
end;
$$;

-- Audit trail for credit entry deletes (was missing)
drop trigger if exists audit_credit_entries_trigger on public.credit_entries;
create trigger audit_credit_entries_trigger
  after insert or update or delete on public.credit_entries
  for each row execute function public.audit_trigger_fn();

-- Safe day-closing delete: only the most recent closing date
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
  'Admin-only: delete the latest day closing so the date can be re-closed.';

grant execute on function public.delete_day_closing(uuid) to authenticated;

-- Internal helper: only callable from security-definer RPCs, not from clients
revoke all on function public.reallocate_credit_settlements(uuid) from public;
revoke all on function public.reallocate_credit_settlements(uuid) from authenticated;
