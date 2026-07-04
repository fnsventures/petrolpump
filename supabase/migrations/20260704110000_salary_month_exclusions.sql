-- Per-employee salary month exclusions (N/A): full-month leave, not yet joined, etc.

create table if not exists public.salary_month_exclusions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  salary_month date not null,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  unique (employee_id, salary_month),
  constraint salary_month_exclusions_month_start check (salary_month = date_trunc('month', salary_month)::date)
);

create index if not exists salary_month_exclusions_month_idx
  on public.salary_month_exclusions (salary_month desc, employee_id);

comment on table public.salary_month_exclusions is
  'Marks a calendar month as not applicable for an employee salary (admin). Excluded from payroll totals.';
comment on column public.salary_month_exclusions.salary_month is
  'First day of the calendar month with no applicable salary for this employee.';
comment on column public.salary_month_exclusions.note is
  'Optional reason (e.g. full-month leave, not yet joined).';

alter table public.salary_month_exclusions enable row level security;

drop policy if exists "salary_month_exclusions_select" on public.salary_month_exclusions;
create policy "salary_month_exclusions_select" on public.salary_month_exclusions
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "salary_month_exclusions_insert_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_insert_admin" on public.salary_month_exclusions
  for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "salary_month_exclusions_update_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_update_admin" on public.salary_month_exclusions
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "salary_month_exclusions_delete_admin" on public.salary_month_exclusions;
create policy "salary_month_exclusions_delete_admin" on public.salary_month_exclusions
  for delete to authenticated using (public.is_admin());

drop trigger if exists audit_salary_month_exclusions_trigger on public.salary_month_exclusions;
create trigger audit_salary_month_exclusions_trigger
  after insert or update or delete on public.salary_month_exclusions
  for each row execute function public.audit_trigger_fn();
