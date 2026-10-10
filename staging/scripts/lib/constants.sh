# Shared constants for Supabase maintenance scripts.

PG_DOCKER_IMAGE="${PG_DOCKER_IMAGE:-postgres:17}"

AUTH_DUMP_EXCLUDES="auth.sessions,auth.refresh_tokens,auth.mfa_factors,auth.mfa_challenges,auth.mfa_amr_claims,auth.one_time_tokens,auth.flow_state,auth.audit_log_entries"

STORAGE_DUMP_EXCLUDES="storage.buckets_analytics,storage.buckets_vectors,storage.s3_multipart_uploads,storage.s3_multipart_uploads_parts,storage.vector_indexes"

PUBLIC_SYNC_EXCLUDES="public.dsr,public.dsr_stock"
