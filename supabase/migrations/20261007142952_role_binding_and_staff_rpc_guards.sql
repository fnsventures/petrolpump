-- Bind roles to auth.users.id, and stop unprovisioned callers using
-- invoice numbers, shift cash sync, and Drive archive enqueue.

alter table public.users
  add column if not exists auth_user_id uuid references auth.users (id) on delete set null;

comment on column public.users.auth_user_id is
  'auth.users.id for this login. Role checks use this, not the email claim.';

create unique index if not exists users_auth_user_id_key
  on public.users (auth_user_id)
  where auth_user_id is not null;

update public.users u
set auth_user_id = a.id
from auth.users a
where u.auth_user_id is null
  and lower(trim(u.email)) = lower(trim(a.email));

-- Fill auth_user_id when the app row is written after the Auth user exists.
create or replace function public.set_app_user_auth_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auth_id uuid;
begin
  select a.id
  into v_auth_id
  from auth.users a
  where lower(trim(a.email)) = lower(trim(new.email))
  limit 1;

  if v_auth_id is not null then
    new.auth_user_id := v_auth_id;
  end if;
  return new;
end;
$$;

comment on function public.set_app_user_auth_id() is
  'Sets users.auth_user_id from auth.users when the emails match.';

drop trigger if exists users_set_auth_id on public.users;
create trigger users_set_auth_id
  before insert or update of email on public.users
  for each row execute function public.set_app_user_auth_id();

-- Fill auth_user_id when the Auth user is created after the app row.
create or replace function public.link_app_user_auth_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
  set auth_user_id = new.id
  where auth_user_id is null
    and lower(trim(email)) = lower(trim(new.email));
  return new;
end;
$$;

comment on function public.link_app_user_auth_id() is
  'Links a new Auth user to a public.users row that does not yet have auth_user_id.';

drop trigger if exists auth_users_link_app_user on auth.users;
create trigger auth_users_link_app_user
  after insert or update of email on auth.users
  for each row execute function public.link_app_user_auth_id();

revoke all on function public.set_app_user_auth_id() from public, anon, authenticated;
revoke all on function public.link_app_user_auth_id() from public, anon, authenticated;

create or replace function public.get_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role
  from public.users
  where auth_user_id = auth.uid()
  limit 1;
$$;

comment on function public.get_user_role() is
  'Returns admin/supervisor from public.users for auth.uid(). Null if not provisioned.';

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    else coalesce(public.get_user_role() = 'admin', false)
  end;
$$;

comment on function public.is_admin() is
  'True when auth.uid() is a provisioned admin. False for any other login. Null when there is no login (restore / SQL editor).';

create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select case
    when auth.uid() is null then null
    else coalesce(public.get_user_role() in ('admin', 'supervisor'), false)
  end;
$$;

comment on function public.is_supervisor_or_admin() is
  'True when auth.uid() is provisioned staff. False for any other login. Null when there is no login (restore / SQL editor).';

create or replace function public.require_staff_access()
returns void
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  -- No login: table owner, service role, or a restore. Not a signed-up stranger.
  if auth.uid() is null then
    return;
  end if;
  if not public.is_supervisor_or_admin() then
    raise exception 'Provisioned staff access required';
  end if;
end;
$$;

create or replace function public.upsert_staff(
  p_email text,
  p_role text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_auth_id uuid;
begin
  if not public.is_admin() then
    if exists (select 1 from public.users where role = 'admin') then
      raise exception 'Access denied: Admin role required';
    end if;
    if lower(trim(p_email)) <> lower(trim(auth.jwt() ->> 'email')) then
      raise exception 'Bootstrap: can only provision your own email as the first admin';
    end if;
    if p_role <> 'admin' then
      raise exception 'Bootstrap: first user must be admin';
    end if;
  end if;
  if p_role not in ('admin', 'supervisor') then
    raise exception 'Invalid role: must be admin or supervisor';
  end if;
  if p_email is null or trim(p_email) = '' then
    raise exception 'Email is required';
  end if;

  select a.id
  into v_auth_id
  from auth.users a
  where lower(trim(a.email)) = lower(trim(p_email))
  limit 1;

  if v_auth_id is null then
    raise exception 'Create this login in Supabase Authentication first';
  end if;

  insert into public.users (email, role, display_name, auth_user_id)
  values (lower(trim(p_email)), p_role, nullif(trim(p_display_name), ''), v_auth_id)
  on conflict (email) do update set
    role = excluded.role,
    display_name = excluded.display_name,
    auth_user_id = excluded.auth_user_id
  returning jsonb_build_object(
    'id', id,
    'email', email,
    'role', role,
    'display_name', display_name,
    'auth_user_id', auth_user_id
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.update_my_avatar(p_avatar_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_staff_access();
  update public.users
  set avatar_url = nullif(trim(p_avatar_url), '')
  where auth_user_id = auth.uid();
  if not found then
    raise exception 'User not provisioned';
  end if;
end;
$$;

create or replace function public.generate_invoice_number()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text;
  v_seq integer;
  v_number text;
begin
  perform public.require_staff_access();
  v_year := to_char(current_date, 'YYYY');
  v_seq := nextval('public.invoice_number_seq');
  v_number := 'CRI/' || lpad(v_seq::text, 4, '0');
  return v_number;
end;
$$;

comment on function public.generate_invoice_number() is
  'Next CRI/NNNN invoice number. Provisioned staff only.';

revoke all on function public.generate_invoice_number() from public, anon;
grant execute on function public.generate_invoice_number() to authenticated;

create or replace function public.sync_meter_shift_cash_ledger_totals(
  p_date date,
  p_shift text,
  p_employee_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift text := lower(btrim(coalesce(p_shift, '')));
  v_credit numeric := 0;
  v_expense numeric := 0;
begin
  perform public.require_staff_access();

  if p_date is null or p_employee_id is null or v_shift not in ('morning', 'afternoon') then
    return;
  end if;

  select
    coalesce((
      select sum(ce.amount)
      from public.credit_entries ce
      where ce.transaction_date = p_date
        and ce.shift = v_shift
        and ce.employee_id = p_employee_id
    ), 0),
    coalesce((
      select sum(ex.amount)
      from public.expenses ex
      where ex.date = p_date
        and ex.shift = v_shift
        and ex.employee_id = p_employee_id
    ), 0)
  into v_credit, v_expense;

  insert into public.meter_shift_cash (
    reading_date, shift, employee_id,
    cash_collected, phone_pay, credit_amount, expense_amount,
    updated_at
  )
  values (
    p_date, v_shift, p_employee_id,
    0, 0, v_credit, v_expense,
    timezone('utc'::text, now())
  )
  on conflict (reading_date, shift, employee_id)
  do update set
    credit_amount = excluded.credit_amount,
    expense_amount = excluded.expense_amount,
    updated_at = timezone('utc'::text, now());
end;
$$;

comment on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) is
  'Refresh meter_shift_cash credit_amount/expense_amount from attributed ledger rows. Provisioned staff only.';

revoke all on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) from public, anon;
grant execute on function public.sync_meter_shift_cash_ledger_totals(date, text, uuid) to authenticated;

create or replace function public.enqueue_drive_pdf_archive(p_kind text, p_record_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_host text;
  v_auth text;
  v_apikey text;
  v_url text;
  v_payload jsonb;
  v_drive jsonb;
begin
  perform public.require_staff_access();

  begin
    if p_kind is null or p_record_id is null then
      return;
    end if;

    select config->'integrations'->'googleDrive'
      into v_drive
    from public.pump_settings
    where id = 1;
    if coalesce(v_drive->>'enabled', '') <> 'true'
       or length(trim(coalesce(v_drive->>'rootFolderId', ''))) = 0 then
      return;
    end if;

    begin
      v_headers := current_setting('request.headers', true)::jsonb;
    exception when others then
      return;
    end;
    if v_headers is null then
      return;
    end if;

    v_host := nullif(trim(v_headers->>'host'), '');
    v_auth := nullif(trim(v_headers->>'authorization'), '');
    v_apikey := coalesce(nullif(trim(v_headers->>'apikey'), ''), nullif(trim(v_headers->>'x-api-key'), ''));
    if v_host is null or v_auth is null then
      return;
    end if;

    v_url := case
      when v_host like '%localhost%' or v_host like '127.0.0.1%'
        then 'http://' || v_host || '/functions/v1/drive-files'
      else 'https://' || v_host || '/functions/v1/drive-files'
    end;

    if p_kind = 'sales_invoice' then
      v_payload := jsonb_build_object('action', 'archive', 'kind', 'sales_invoice', 'invoiceId', p_record_id);
    elsif p_kind = 'letter' then
      v_payload := jsonb_build_object('action', 'archive', 'kind', 'letter', 'letterId', p_record_id);
    else
      return;
    end if;

    perform net.http_post(
      url := v_url,
      headers := jsonb_strip_nulls(jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', v_auth,
        'apikey', v_apikey
      )),
      body := v_payload,
      timeout_milliseconds := 25000
    );
  exception
    when others then
      raise warning 'enqueue_drive_pdf_archive failed: %', sqlerrm;
  end;
end;
$$;

comment on function public.enqueue_drive_pdf_archive(text, uuid) is
  'Fire-and-forget Drive PDF archive via pg_net. Provisioned staff only. Never blocks invoice/letter save.';

revoke all on function public.enqueue_drive_pdf_archive(text, uuid) from public, anon;
grant execute on function public.enqueue_drive_pdf_archive(text, uuid) to authenticated;
