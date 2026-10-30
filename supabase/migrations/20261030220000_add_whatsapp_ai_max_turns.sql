-- Add whatsapp_ai_max_turns to clinic_settings
ALTER TABLE clinic_settings 
ADD COLUMN IF NOT EXISTS whatsapp_ai_max_turns integer NOT NULL DEFAULT 8;

COMMENT ON COLUMN clinic_settings.whatsapp_ai_max_turns IS 'Maximum reasoning / tool calling turns per patient message for the WhatsApp AI receptionist (default 8, range 3 to 15)';
