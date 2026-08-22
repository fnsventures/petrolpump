-- Clean model: shift register never writes dsr_*. Drop the obsolete no-op RPC.
-- Prefill uses get_shift_aggregated_daily_meters; finished sheets own dsr_* writes.

drop function if exists public.sync_dsr_meters_from_shifts(date);
