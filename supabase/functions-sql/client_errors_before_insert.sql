-- Canonical definition of public.client_errors_before_insert. Edit here, then:
--   node scripts/sql-functions.mjs emit client_errors_before_insert
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
