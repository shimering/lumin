# Online voice charting

Lumin's **Voice charting** control uses the Gemma Voice pilot's online Gemma 4 E2B bridge. Configure the Lumin Cloudflare Worker with the pilot's existing HTTPS bridge base URL via `GEMMA_BRIDGE_URL` and its bearer token via the Worker secret `GEMMA_BRIDGE_TOKEN`. The base URL ends at the bridge prefix, such as `https://host.example/gemma-bridge`. Lumin appends `/api/chart`. Keep the bridge and its Gemma model service running.

With chart access, open a test patient's dental chart and submit a typed or recorded command such as “Plan an occlusal composite on upper right six and seven.” Verify that both permanent teeth appear in the review. Select the matching clinic catalog procedure, check the status and surfaces, then add the procedures to the chart. Try a bare tooth number to verify that Gemma asks for the quadrant. This first version supports composite restorations, root canals, crowns and extractions from the active clinic catalog.

The model request carries the command text or recording. Patient and account identifiers and chart data stay in Lumin. Staff should leave patient identifiers out of the command itself.
