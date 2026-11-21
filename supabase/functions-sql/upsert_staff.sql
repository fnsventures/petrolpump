-- Canonical definition of public.upsert_staff. Edit here, then:
--   node scripts/sql-functions.mjs emit upsert_staff
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
    if coalesce(current_setting('app.allow_first_admin', true), '') is distinct from 'on'
       or exists (select 1 from public.users where role = 'admin')
       or lower(trim(p_email)) <> lower(trim(coalesce(auth.jwt() ->> 'email', '')))
       or p_role <> 'admin' then
      raise exception 'Access denied: Admin role required';
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

grant execute on function public.upsert_staff(text, text, text) to authenticated;
