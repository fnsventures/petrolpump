-- Canonical definition of public.delete_day_closing. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_day_closing
create or replace function public.delete_day_closing(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
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

  if coalesce(v_row.certified, false) then
    raise exception
      'Day closing for % is certified and locked. Revoke certification before deleting it.',
      v_row.date;
  end if;

  if v_row.night_cash_collection_id is not null then
    raise exception 'Day closing for % is locked: night cash was collected.', v_row.date;
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
  'Admin-only: delete the latest uncertified day closing so the date can be re-closed.';

grant execute on function public.delete_day_closing(uuid) to authenticated;
