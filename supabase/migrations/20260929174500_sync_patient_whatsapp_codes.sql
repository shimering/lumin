-- Add updated_at to patients table if missing
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Backfill whatsapp_code on patients from linked whatsapp_conversations
UPDATE patients p
SET whatsapp_code = CASE
  WHEN c.phone LIKE '+%' THEN c.phone
  ELSE '+' || c.phone
END,
updated_at = now()
FROM whatsapp_conversations c
WHERE c.patient_id = p.id
  AND (c.phone LIKE 'EG.%' OR c.phone LIKE '+EG.%')
  AND (p.whatsapp_code IS NULL OR p.whatsapp_code = '');
