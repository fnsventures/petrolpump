-- Supabase Advisor: dsr and dsr_stock were SECURITY DEFINER views (default in PG < 15
-- and when security_invoker is not set). Run as the querying user so RLS on
-- dsr_petrol / dsr_diesel applies.

alter view public.dsr set (security_invoker = true);
alter view public.dsr_stock set (security_invoker = true);
