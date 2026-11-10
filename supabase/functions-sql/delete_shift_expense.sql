-- Canonical definition of public.delete_shift_expense. Edit here, then:
--   node scripts/sql-functions.mjs emit delete_shift_expense
create or replace function public.delete_shift_expense(p_expense_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row public.expenses%rowtype;
begin
  perform public.require_staff_access();

  select * into v_row from public.expenses where id = p_expense_id;
  if not found then
    raise exception 'Expense not found';
  end if;
  if v_row.employee_id is null or v_row.shift is null then
    raise exception 'Only shift-register expenses can be removed here';
  end if;

  perform public.require_meter_shift_writable(v_row.date, v_row.shift);

  if not public.is_admin() and v_row.created_by is distinct from auth.uid() then
    raise exception 'Only the creator or an admin can remove this expense';
  end if;

  delete from public.expenses where id = p_expense_id;

  return jsonb_build_object('deleted', true, 'id', p_expense_id);
end;
$$;

comment on function public.delete_shift_expense(uuid) is
  'Remove a shift-attributed expense; respects shift write lock; cache sync via trigger.';

grant execute on function public.delete_shift_expense(uuid) to authenticated;
