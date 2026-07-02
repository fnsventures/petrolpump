-- Salary pay period vs payment date; reliable expense ↔ payment link

alter table public.salary_payments
  add column if not exists salary_month date;

update public.salary_payments
  set salary_month = date_trunc('month', date)::date
  where salary_month is null;

alter table public.salary_payments
  alter column salary_month set not null;

create index if not exists salary_payments_salary_month_idx
  on public.salary_payments (salary_month desc, employee_id);

comment on column public.salary_payments.salary_month is
  'First day of the calendar month this payment applies to. Cash payment date may differ (e.g. January salary paid in February).';

alter table public.expenses
  add column if not exists salary_payment_id uuid references public.salary_payments (id) on delete set null;

create unique index if not exists expenses_salary_payment_id_unique
  on public.expenses (salary_payment_id)
  where salary_payment_id is not null;

comment on column public.expenses.salary_payment_id is
  'When category is salary, links to the salary_payments row that created this expense.';
