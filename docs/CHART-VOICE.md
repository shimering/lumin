# On-device voice charting

Open a patient’s **Dental Chart → Voice charting** and choose **Download model · 2.4 GB**. Gemma 4 E2B requires a compatible WebGPU browser and enough site storage. Setup downloads the runtime and model to this browser and verifies a sample command. An interrupted model download can resume. **Delete model** removes this model and its runtime cache from the device.

Select **Record command** and say the tooth, procedure, status, and any surfaces. Gemma stops after three seconds of silence or when you tap **Stop recording**. For a synthetic test, say “Plan an occlusal composite on upper right six and seven.” The draft uses the active clinic catalog and supports composite restorations, root canals, crowns and extractions.

With **Spoken confirmation** enabled, Lumin reads a complete draft using a matching local device voice. Choose **Say confirm or cancel** to record a reply. If you edit the draft, choose **Read draft aloud** before recording a reply. A device without a matching local voice can still show the draft on screen. **Add to chart** is also available for manual confirmation.

Interpretation works locally while an already-loaded patient chart is open offline. Keep the chart open and reconnect before saving the confirmed draft to the shared chart. Recordings are processed in the browser without a bridge, hosted model, or API key.
