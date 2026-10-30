-- Client error capture: AppError.report (js/errorHandler.js) batches browser errors into this
-- table so a failure on a staff phone is visible to an admin (Settings → App errors).
--
-- Any login may insert; only admins read. A before-insert trigger sets user, email and role from
-- the session (the client cannot spoof them), trims long text, drops rows past 30 per user per
-- minute (a stuck error loop), and deletes rows older than 90 days.

create table if not exists public.client_errors (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default timezone('utc'::text, now()),
  occurred_at timestamptz,
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  user_email text,
  role text,
  page text,
  message text not null,
  code text,
  name text,
  stack text,
  context jsonb,
  app_version text,
  app_env text,
  user_agent text
);

create index if not exists client_errors_created_at_idx on public.client_errors (created_at desc);
create index if not exists client_errors_user_created_idx on public.client_errors (user_id, created_at desc);

comment on table public.client_errors is
  'Browser errors sent by AppError.report. Insert: any login (user, email, role set by client_errors_before_insert). Select: admin. Rows older than 90 days are deleted on insert.';

alter table public.client_errors enable row level security;

revoke all on table public.client_errors from anon, authenticated;
grant select, insert on table public.client_errors to authenticated;

drop policy if exists "client_errors_insert_own" on public.client_errors;
create policy "client_errors_insert_own" on public.client_errors
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "client_errors_select_admin" on public.client_errors;
create policy "client_errors_select_admin" on public.client_errors
  for select
  to authenticated
  using ((select public.is_admin()));

create or replace function public.client_errors_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.id := gen_random_uuid();
  new.created_at := timezone('utc'::text, now());
  new.user_id := auth.uid();
  new.user_email := nullif(auth.jwt() ->> 'email', '');
  new.role := public.get_user_role();
  new.page := left(new.page, 200);
  new.message := left(coalesce(nullif(new.message, ''), '(no message)'), 2000);
  new.code := left(new.code, 100);
  new.name := left(new.name, 100);
  new.stack := left(new.stack, 4000);
  new.app_version := left(new.app_version, 100);
  new.app_env := left(new.app_env, 20);
  new.user_agent := left(new.user_agent, 400);
  if new.context is not null and octet_length(new.context::text) > 4000 then
    new.context := jsonb_build_object('truncated', left(new.context::text, 4000));
  end if;
  if new.occurred_at is null or new.occurred_at > new.created_at + interval '5 minutes' then
    new.occurred_at := new.created_at;
  end if;

  if (select count(*) from public.client_errors
      where user_id is not distinct from new.user_id
        and created_at > new.created_at - interval '1 minute') >= 30 then
    return null;
  end if;

  delete from public.client_errors where created_at < new.created_at - interval '90 days';
  return new;
end;
$$;

comment on function public.client_errors_before_insert() is
  'Trigger: stamps user, email and role from the session, trims text, drops rows past 30 per user per minute, deletes rows older than 90 days.';

revoke execute on function public.client_errors_before_insert() from public, anon;

drop trigger if exists client_errors_before_insert on public.client_errors;
create trigger client_errors_before_insert
  before insert on public.client_errors
  for each row execute function public.client_errors_before_insert();
