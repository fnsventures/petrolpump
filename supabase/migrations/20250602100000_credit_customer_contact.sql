-- Credit customer contact details (mobile, address) and supervisor edit access

alter table public.credit_customers
  add column if not exists mobile text,
  add column if not exists address text;

alter table public.credit_customers
  drop constraint if exists credit_customers_mobile_check,
  drop constraint if exists credit_customers_address_check;

alter table public.credit_customers
  add constraint credit_customers_mobile_check
    check (mobile is null or char_length(trim(mobile)) <= 20),
  add constraint credit_customers_address_check
    check (address is null or char_length(trim(address)) <= 500);

comment on column public.credit_customers.mobile is 'Customer mobile / phone (optional)';
comment on column public.credit_customers.address is 'Customer address (optional)';

-- Supervisors and admins may update any credit customer (contact info, settlements via RPC)
drop policy if exists "credit_update_by_role" on public.credit_customers;
create policy "credit_update_by_role" on public.credit_customers
  for update
  to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop function if exists public.add_credit_entry(text, date, numeric, text, text, numeric, text);

create or replace function public.add_credit_entry(
  p_customer_name text,
  p_transaction_date date,
  p_amount numeric,
  p_vehicle_no text default null,
  p_fuel_type text default 'HSD',
  p_quantity numeric default 1,
  p_notes text default null,
  p_mobile text default null,
  p_address text default null
)
returns jsonb
language plpgsql security definer
as $$
declare
  v_customer_id uuid;
  v_entry_id uuid;
  v_fuel_type text;
  v_quantity numeric;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_transaction_date > current_date then
    raise exception 'transaction date cannot be in the future';
  end if;

  v_fuel_type := coalesce(nullif(trim(p_fuel_type), ''), 'HSD');
  if v_fuel_type not in ('MS', 'HSD') then
    raise exception 'fuel_type must be MS or HSD';
  end if;

  v_quantity := coalesce(nullif(p_quantity, 0), 1);
  if v_quantity <= 0 then
    raise exception 'quantity must be positive when provided';
  end if;

  select id into v_customer_id
  from public.credit_customers
  where trim(lower(customer_name)) = trim(lower(p_customer_name))
  order by created_at desc limit 1;

  if v_customer_id is null then
    insert into public.credit_customers (
      customer_name, vehicle_no, amount_due, date, notes, mobile, address, created_by
    )
    values (
      trim(p_customer_name),
      nullif(trim(p_vehicle_no), ''),
      0,
      p_transaction_date,
      nullif(trim(p_notes), ''),
      nullif(trim(p_mobile), ''),
      nullif(trim(p_address), ''),
      auth.uid()
    )
    returning id into v_customer_id;
  elsif nullif(trim(p_mobile), '') is not null
     or nullif(trim(p_address), '') is not null then
    update public.credit_customers
    set
      mobile = coalesce(nullif(trim(p_mobile), ''), mobile),
      address = coalesce(nullif(trim(p_address), ''), address)
    where id = v_customer_id;
  end if;

  insert into public.credit_entries (credit_customer_id, transaction_date, fuel_type, quantity, amount, created_by)
  values (v_customer_id, p_transaction_date, v_fuel_type, v_quantity, p_amount, auth.uid())
  returning id into v_entry_id;

  return jsonb_build_object(
    'credit_customer_id', v_customer_id,
    'credit_entry_id', v_entry_id,
    'transaction_date', p_transaction_date,
    'amount', p_amount
  );
end;
$$;

comment on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text) is
  'Add a credit sale. Optional mobile/address on new or existing customer. Rejects future dates.';

grant execute on function public.add_credit_entry(text, date, numeric, text, text, numeric, text, text, text) to authenticated;
