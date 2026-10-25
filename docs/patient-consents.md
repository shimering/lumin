# Patient consents

Open a patient and select **Consents**. Choose **New consent**, select a clinic template, review the automatically filled patient information and treating doctor, then edit the text for that patient. Save a draft or finalize the document. Finalization locks the wording; **Print** provides spaces for handwritten patient/guardian, doctor and optional witness/interpreter signatures. Finalized means the text is locked, not that a signature has been collected electronically.

Under **Admin → Consents**, add templates, edit English/Arabic text, archive templates and optionally link them to procedures. Applying a linked procedure on the chart offers to create a consent, retaining the procedure, tooth labels and finding IDs. A template without procedure links remains available for manual selection. Multiple matching templates are offered together.

Template edits create a new revision. Saved patient documents retain their own text, original template revision and patient profile snapshot; they do not inherit subsequent universal edits. Simultaneous edits use revision checks. Drafts remain editable, while finalized documents are immutable. Archiving a template preserves existing patient records.

Seven original bilingual starter forms cover implants, fixed orthodontics, clear aligners, surgical extractions, root canal treatment, crowns/bridges and whitening. Their procedure categories reference the [Dentolize public consent generator](https://dentolize.com/tools/dental-consent-form-generator/); the starter text is original and should be reviewed by the clinic before clinical use.

Clinical reference checks include [Cambridge University Hospitals implant information](https://www.cuh.nhs.uk/patient-information/insertion-of-dental-implants/), [Leeds Teaching Hospitals orthodontic risks](https://www.leedsth.nhs.uk/services/orthodontic-dentistry/benefits-and-risks-of-orthodontic-dentistry/) and [AAE informed consent guidance](https://www.aae.org/specialty/clinical-resources/treatment-planning/informed-consent/).

Available template fields: `{{patient_name}}`, `{{patient_number}}`, `{{birth_date}}`, `{{phone}}`, `{{address}}`, `{{age}}`, `{{gender}}`, `{{doctor_name}}`, `{{date}}`, `{{procedure}}`, `{{details}}`. Saved text is plain text, never executable HTML. The treating doctor defaults to the applied finding's doctor, the latest assigned doctor on the patient's chart, or the current user if they are a doctor. Another doctor can be selected, or a visiting doctor's name entered.

The `patient_consents` migration creates shared templates, patient records, narrow doctor lookup, row-level permissions, revision guards and Realtime publication entries. Clinical staff require Patients or Chart access; only active administrators can alter shared templates. Anonymous accounts have no access. Apply this migration before serving the updated frontend. New browser assets are included in the public asset build and service-worker shell.

Validation: `node --test tests/consents-model.test.cjs tests/consents-sql.test.cjs tests/consents-browser.test.cjs tests/patient-workspace-groups-browser.test.cjs`. Browser checks use local fixture data, not clinic patient data.
