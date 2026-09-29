-- Add whatsapp_username and whatsapp_code columns to patients table
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS whatsapp_username text,
  ADD COLUMN IF NOT EXISTS whatsapp_code text;

CREATE INDEX IF NOT EXISTS idx_patients_whatsapp_code ON patients (whatsapp_code);
CREATE INDEX IF NOT EXISTS idx_patients_whatsapp_username ON patients (whatsapp_username);
