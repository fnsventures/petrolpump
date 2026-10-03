-- Admin can exclude a calculated loss-of-pay amount from one employee's salary month.
-- No row means the calculated loss of pay is deducted.

create table if not exists public.salary_lop_exclusions (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  salary_month date not null,
  note text check (char_length(note) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique (employee_id, salary_month),
  constraint salary_lop_exclusions_month_start check (
    salary_month = date_trunc('month', salary_month)::date
  )
);

create index if not exists salary_lop_exclusions_month_idx
  on public.salary_lop_exclusions (salary_month desc, employee_id);

comment on table public.salary_lop_exclusions is
  'Admin waiver of calculated loss of pay for one employee and salary month. Absent row means the deduction applies.';

comment on column public.salary_lop_exclusions.salary_month is
  'Pay period, first day of the month (same key as salary_payments.salary_month).';

alter table public.salary_lop_exclusions enable row level security;

drop policy if exists "salary_lop_exclusions_select" on public.salary_lop_exclusions;
create policy "salary_lop_exclusions_select" on public.salary_lop_exclusions
  for select to authenticated using (public.is_supervisor_or_admin());

drop policy if exists "salary_lop_exclusions_insert_admin" on public.salary_lop_exclusions;
create policy "salary_lop_exclusions_insert_admin" on public.salary_lop_exclusions
  for insert to authenticated
  with check (public.is_admin() and created_by = auth.uid());

drop policy if exists "salary_lop_exclusions_delete_admin" on public.salary_lop_exclusions;
create policy "salary_lop_exclusions_delete_admin" on public.salary_lop_exclusions
  for delete to authenticated using (public.is_admin());

drop trigger if exists audit_salary_lop_exclusions_trigger on public.salary_lop_exclusions;
create trigger audit_salary_lop_exclusions_trigger
  after insert or update or delete on public.salary_lop_exclusions
  for each row execute function public.audit_trigger_fn();
