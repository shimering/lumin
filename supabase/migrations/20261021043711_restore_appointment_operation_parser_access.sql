-- The chart parser now includes orthodontic visits. Its invoker callers (the
-- appointment picker and assignment validation trigger) need the same access
-- to this nested parser. It only transforms the supplied JSON and reads no tables.
grant execute on function private.ortho_visit_finding_rows(jsonb) to authenticated;
