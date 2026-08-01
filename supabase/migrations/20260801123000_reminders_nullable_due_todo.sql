-- Widen reminders into a general task board: optional due dates + todo type.
-- Safe if 20260801120000 already created the table with NOT NULL due_date.

alter table public.reminders
  alter column due_date drop not null;

alter table public.reminders
  alter column due_date drop default;

alter table public.reminders
  drop constraint if exists reminders_reminder_type_check;

alter table public.reminders
  add constraint reminders_reminder_type_check
  check (reminder_type in ('general', 'todo', 'credit_followup', 'call', 'payment', 'other'));

drop index if exists reminders_open_due_idx;
create index if not exists reminders_open_due_idx
  on public.reminders (due_date asc nulls last, priority)
  where status = 'open';

create index if not exists reminders_open_backlog_idx
  on public.reminders (priority, created_at desc)
  where status = 'open' and due_date is null;

drop index if exists reminders_status_due_idx;
create index if not exists reminders_status_due_idx
  on public.reminders (status, due_date desc nulls last, created_at desc);

comment on table public.reminders is
  'Station tasks: dated reminders and undated todos (credit follow-ups, calls, general work).';

comment on column public.reminders.due_date is
  'When set, item is a dated reminder. Null = undated todo in Backlog (high priority still surfaces on dashboard).';
