-- delete_staff: also remove the Supabase Auth account (auth.users), not just public.users.

create or replace function public.delete_staff(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text := lower(trim(p_email));
  v_auth_id uuid;
  v_app_deleted boolean := false;
begin
  if not public.is_admin() then
    raise exception 'Access denied: Admin role required';
  end if;
  if v_email = lower(trim(auth.jwt() ->> 'email')) then
    raise exception 'Cannot delete your own account';
  end if;

  select id into v_auth_id
  from auth.users
  where lower(trim(email)) = v_email;

  delete from public.users where email = v_email;
  v_app_deleted := found;

  if v_auth_id is not null then
    delete from auth.users where id = v_auth_id;
  end if;

  return v_app_deleted or v_auth_id is not null;
end;
$$;

comment on function public.delete_staff(text) is
  'Securely delete app user and Supabase Auth account with server-side admin validation.';
