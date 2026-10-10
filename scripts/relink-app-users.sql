-- Re-link public.users.auth_user_id after a prod → staging data load.
-- Production may not have this column yet (migration 20261007142952).
-- A data-only dump then leaves every staging row with auth_user_id null,
-- and login is rejected as unprovisioned. Safe to re-run.

update public.users u
set auth_user_id = a.id
from auth.users a
where u.auth_user_id is null
  and lower(trim(u.email)) = lower(trim(a.email));
