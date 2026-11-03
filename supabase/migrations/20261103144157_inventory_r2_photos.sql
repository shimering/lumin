-- Keep one clinic photo revision while allowing a verified copy on either cloud.
alter table public.inventory_item_images alter column drive_file_id drop not null;
alter table public.inventory_item_images add column r2_key text;
alter table public.inventory_item_images add constraint inventory_image_r2_key
  check (r2_key is null or r2_key = 'Lumin Clinic/Inventory/item-' || item_id::text || '-' || revision::text || case when mime_type='image/webp' then '.webp' else '.jpg' end);
alter table public.inventory_item_images add constraint inventory_image_location
  check (drive_file_id is not null or r2_key is not null);
-- Existing RLS and column grants continue to hide both storage pointers and hashes.
comment on column public.inventory_item_images.r2_key is 'Private immutable R2 photo key for this inventory image revision.';
