-- Completing a reminder removes the row. Supervisors already finish reminders;
-- they need the same delete right as admins. Existing completed rows are cleared
-- so they are not kept on the done list.

drop policy if exists "reminders_delete_admin" on public.reminders;
drop policy if exists "reminders_delete_staff" on public.reminders;
create policy "reminders_delete_staff" on public.reminders
  for delete to authenticated
  using (public.is_supervisor_or_admin());

delete from public.reminders
where status = 'done';
