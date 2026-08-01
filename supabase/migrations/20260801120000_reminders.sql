-- Station tasks: dated reminders + undated todos (credit calls, follow-ups, general work).
-- Shared across admin and supervisor; due / high-priority items surface on the dashboard.

create table if not exists public.reminders (
  id uuid primary key default uuid_generate_v4(),
  title text not null
    check (char_length(trim(title)) between 1 and 200),
  notes text
    check (notes is null or char_length(notes) <= 2000),
  -- null due_date = undated todo (Backlog); set a date to treat as a reminder
  due_date date,
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high')),
  reminder_type text not null default 'general'
    check (reminder_type in ('general', 'todo', 'credit_followup', 'call', 'payment', 'other')),
  status text not null default 'open'
    check (status in ('open', 'done', 'cancelled')),
  credit_customer_id uuid references public.credit_customers (id) on delete set null,
  completed_at timestamptz,
  completed_by uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint reminders_completed_consistency check (
    (status = 'done' and completed_at is not null)
    or (status <> 'done' and completed_at is null and completed_by is null)
  )
);

create index if not exists reminders_open_due_idx
  on public.reminders (due_date asc nulls last, priority)
  where status = 'open';

create index if not exists reminders_open_backlog_idx
  on public.reminders (priority, created_at desc)
  where status = 'open' and due_date is null;

create index if not exists reminders_status_due_idx
  on public.reminders (status, due_date desc nulls last, created_at desc);

create index if not exists reminders_credit_customer_idx
  on public.reminders (credit_customer_id)
  where credit_customer_id is not null;

comment on table public.reminders is
  'Station tasks: dated reminders and undated todos (credit follow-ups, calls, general work).';

comment on column public.reminders.due_date is
  'When set, item is a dated reminder. Null = undated todo in Backlog (high priority still surfaces on dashboard).';

alter table public.reminders enable row level security;

drop policy if exists "reminders_select" on public.reminders;
create policy "reminders_select" on public.reminders
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "reminders_insert_own" on public.reminders;
create policy "reminders_insert_own" on public.reminders
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

-- Any provisioned staff may complete or edit any open task (shared ops board).
drop policy if exists "reminders_update_staff" on public.reminders;
create policy "reminders_update_staff" on public.reminders
  for update to authenticated
  using (public.is_supervisor_or_admin())
  with check (public.is_supervisor_or_admin());

drop policy if exists "reminders_delete_admin" on public.reminders;
create policy "reminders_delete_admin" on public.reminders
  for delete to authenticated
  using (public.is_admin());

-- Page access for admin and supervisor
create or replace function public.check_page_access(p_page text)
returns jsonb
language plpgsql
security definer
stable
as $$
declare
  v_role text;
  v_allowed boolean;
begin
  v_role := public.get_user_role();

  v_allowed := case p_page
    when 'settings' then v_role = 'admin'
    when 'staff' then v_role in ('admin', 'supervisor')
    when 'analysis' then v_role = 'admin'
    when 'reports' then v_role = 'admin'
    when 'dashboard' then v_role in ('admin', 'supervisor')
    when 'dsr' then v_role in ('admin', 'supervisor')
    when 'day-closing' then v_role in ('admin', 'supervisor')
    when 'expenses' then v_role in ('admin', 'supervisor')
    when 'credit-overdue' then v_role in ('admin', 'supervisor')
    when 'credit' then v_role in ('admin', 'supervisor')
    when 'sales-daily' then v_role in ('admin', 'supervisor')
    when 'attendance' then v_role in ('admin', 'supervisor')
    when 'salary' then v_role in ('admin', 'supervisor')
    when 'billing' then v_role in ('admin', 'supervisor')
    when 'invoices' then v_role in ('admin', 'supervisor')
    when 'letterhead' then v_role in ('admin', 'supervisor')
    when 'reminders' then v_role in ('admin', 'supervisor')
    else false
  end;

  return jsonb_build_object(
    'allowed', v_allowed,
    'role', v_role,
    'page', p_page
  );
end;
$$;

comment on function public.check_page_access(text) is
  'Server-side page access validation. Returns allowed status and user role.';
