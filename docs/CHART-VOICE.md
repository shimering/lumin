# On-device voice charting

Open a patient’s **Dental Chart → Voice charting** and choose **Download model · 2.4 GB**. Gemma 4 E2B requires a compatible WebGPU browser and enough site storage. Setup downloads the runtime and model to this browser and verifies a sample command. An interrupted model download can resume. **Delete model** removes this model and its runtime cache from the device.

Select **Record command** and say the tooth, procedure, status, and any surfaces. Recording stops after three seconds of silence, after 25 seconds, or when you tap **Stop recording**. A batch can contain up to eight procedures. Try “Plan an occlusal filling on upper right six and seven.” The draft uses the active clinic catalog for composite restorations, root canals, crowns and extractions. If a command is partly unclear, the draft keeps the recognized rows. Use **Record missing items** and give the tooth and procedure for each missing item, then fill any empty fields in the draft.

With **Read aloud and listen for confirmation** enabled, Lumin reads a complete draft using a matching local device voice and starts listening when the readback ends. Say “confirm”, “yes, go ahead”, or “cancel”. One confirmation saves the whole batch. If readback is unavailable or you edit the draft, review it on screen and use **Say confirm or cancel** or **Add to chart**. Gemma stays loaded between recordings until you close voice charting or leave it idle for two minutes.

Interpretation works locally while an already-loaded patient chart is open offline. Keep the chart open and reconnect before saving the confirmed draft to the shared chart. Recordings are processed in the browser without a bridge, hosted model, or API key.
