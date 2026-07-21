-- Typed letterhead history (blank stationery is not stored).

create table if not exists public.letterhead_letters (
  id uuid primary key default uuid_generate_v4(),
  letter_date date not null default current_date,
  subject text not null default '',
  body text not null default '',
  export_type text not null default 'print'
    check (export_type in ('print', 'word')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint letterhead_letters_has_content check (
    length(trim(subject)) > 0 or length(trim(body)) > 0
  )
);

create index if not exists letterhead_letters_date_idx
  on public.letterhead_letters (letter_date desc, created_at desc);

create index if not exists letterhead_letters_created_at_idx
  on public.letterhead_letters (created_at desc);

comment on table public.letterhead_letters is
  'History of typed station letterhead letters (print/Word). Blank stationery is not recorded.';

alter table public.letterhead_letters enable row level security;

drop policy if exists "letterhead_letters_select" on public.letterhead_letters;
create policy "letterhead_letters_select" on public.letterhead_letters
  for select to authenticated
  using (public.is_supervisor_or_admin());

drop policy if exists "letterhead_letters_insert_own" on public.letterhead_letters;
create policy "letterhead_letters_insert_own" on public.letterhead_letters
  for insert to authenticated
  with check (
    public.is_supervisor_or_admin()
    and created_by = auth.uid()
  );

drop policy if exists "letterhead_letters_update_by_role" on public.letterhead_letters;
create policy "letterhead_letters_update_by_role" on public.letterhead_letters
  for update to authenticated
  using (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  )
  with check (
    public.is_supervisor_or_admin()
    and (created_by = auth.uid() or public.is_admin())
  );

drop policy if exists "letterhead_letters_delete_admin" on public.letterhead_letters;
create policy "letterhead_letters_delete_admin" on public.letterhead_letters
  for delete to authenticated
  using (public.is_admin());
