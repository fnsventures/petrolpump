# Shared constants for Supabase maintenance scripts.

PG_DOCKER_IMAGE="${PG_DOCKER_IMAGE:-postgres:17}"

STORAGE_DUMP_EXCLUDES="storage.buckets_analytics,storage.buckets_vectors,storage.s3_multipart_uploads,storage.s3_multipart_uploads_parts,storage.vector_indexes"

# public.users stays staging-only: staging has its own logins.
PUBLIC_SYNC_EXCLUDES="public.dsr,public.dsr_stock,public.users"
