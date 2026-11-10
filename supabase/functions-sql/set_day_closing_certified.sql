-- Canonical definition of public.set_day_closing_certified. Edit here, then:
--   node scripts/sql-functions.mjs emit set_day_closing_certified
create or replace function public.set_day_closing_certified(
  p_date date,
  p_certified boolean,
  p_reason text default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_existing record;
  v_name text;
  v_at timestamptz;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can certify or remove certification on a day closing';
  end if;

  if p_date is null then
    raise exception 'date is required';
  end if;

  select date, closing_reference, certified, certified_at, certified_by_name
  into v_existing
  from public.day_closing
  where date = p_date
  for update;

  if not found then
    raise exception 'Save day closing for % before certifying it.', p_date;
  end if;

  if coalesce(p_certified, false) then
    if coalesce(v_existing.certified, false) then
      return jsonb_build_object(
        'date', v_existing.date,
        'closing_reference', v_existing.closing_reference,
        'certified', true,
        'certified_at', v_existing.certified_at,
        'certified_by_name', v_existing.certified_by_name
      );
    end if;

    select coalesce(nullif(trim(u.display_name), ''), u.email)
    into v_name
    from public.users u
    where lower(trim(u.email)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    limit 1;
    v_name := coalesce(nullif(trim(v_name), ''), 'Admin');
    v_at := timezone('utc'::text, now());

    update public.day_closing set
      certified = true,
      certified_at = v_at,
      certified_by = auth.uid(),
      certified_by_name = v_name,
      revoke_reason = null
    where date = p_date;

    return jsonb_build_object(
      'date', p_date,
      'closing_reference', v_existing.closing_reference,
      'certified', true,
      'certified_at', v_at,
      'certified_by_name', v_name
    );
  end if;

  if not coalesce(v_existing.certified, false) then
    return jsonb_build_object(
      'date', v_existing.date,
      'closing_reference', v_existing.closing_reference,
      'certified', false,
      'certified_at', null,
      'certified_by_name', null
    );
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null
     or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required to remove certification';
  end if;

  perform set_config('app.force_audit', 'true', true);
  update public.day_closing set
    certified = false,
    certified_at = null,
    certified_by = null,
    certified_by_name = null,
    revoke_reason = trim(p_reason)
  where date = p_date;
  perform set_config('app.force_audit', '', true);

  return jsonb_build_object(
    'date', p_date,
    'closing_reference', v_existing.closing_reference,
    'certified', false,
    'certified_at', null,
    'certified_by_name', null
  );
end;
$$;

comment on function public.set_day_closing_certified(date, boolean, text) is
  'Admin-only: certify a saved statement or revoke it. Revoke requires a reason and always writes an audit row.';

grant execute on function public.set_day_closing_certified(date, boolean, text) to authenticated;
