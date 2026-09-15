-- Migration: get_whatsapp_storage_usage RPC function
-- Purpose: Safely query file count and total size used by whatsapp-media bucket out of the 1GB free tier.

CREATE OR REPLACE FUNCTION public.get_whatsapp_storage_usage()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS 
DECLARE
    result json;
BEGIN
    SELECT json_build_object(
        'total_files', COUNT(o.id),
        'total_bytes', COALESCE(SUM((o.metadata->>'size')::bigint), 0),
        'max_bytes', 1073741824 -- 1 GB in bytes
    )
    INTO result
    FROM storage.objects o
    WHERE o.bucket_id = 'whatsapp-media';
    
    RETURN result;
END;
;

GRANT EXECUTE ON FUNCTION public.get_whatsapp_storage_usage() TO authenticated, anon, service_role;
