export const procedures = {
  composite: "Composite filling",
  root_canal: "Root canal",
  crown: "Crown",
  extraction: "Extraction",
};
export const procedureStatuses = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  existed: "Existed",
};
export const surfaces = {
  mesial: "Mesial",
  distal: "Distal",
  occlusal: "Occlusal",
  buccal: "Buccal",
  lingual: "Lingual",
  incisal: "Incisal",
};
export const quadrants = {
  UR: "Upper right",
  UL: "Upper left",
  LR: "Lower right",
  LL: "Lower left",
};
export const toothIds = Object.keys(quadrants).flatMap((quadrant) =>
  Array.from({ length: 8 }, (_, index) => quadrant + (index + 1))
);

export const maxChartOperations = 8;
export const chartPrompt = `Interpret a staff command for a dental chart. Recognize English and Egyptian Arabic. Never recommend treatment or claim to save records. Use Palmer notation such as UR6 for upper right six, UL4 for upper left four, LL6 for lower left six, and LR6 for lower right six. "ستة فوق يمين" means UR6. A shared quadrant applies to all numbers in its group, as in "upper right six and seven". A number without a quadrant or explicit numbering system is ambiguous. For explicitly named FDI, the first digit is 1=UR, 2=UL, 3=LL, 4=LR and the second is the Palmer position.
Return a flat operations array with one object per tooth and procedure pair, in spoken order. "Plan crowns on UR6 and UR7" means two planned crown operations. "On UL4, add a completed root canal and a planned crown" means two operations on UL4 with different statuses. Preserve explicit mappings and apply shared modifiers only where the wording supports them.
Procedure codes: composite (composite filling, حشو كومبوزيت), root_canal (root canal, علاج عصب), crown (crown, طربوش), extraction (extraction, خلع). Status codes: planned, in_progress, completed, existed. Use "" for an unspecified status and [] for unspecified surfaces. MOD means mesial, occlusal, distal. For a valid command with up to ${maxChartOperations} operations set action=add_procedure and message="". If any requested tooth, procedure, or mapping is unclear or unsupported, or the command exceeds ${maxChartOperations} operations, return action=clarify with operations=[] and one short question in the user's language. Always include heard as the exact wording or best transcription in the original language. Output only the required JSON.`;

export const chartSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["add_procedure", "clarify"] },
    operations: {
      type: "array", maxItems: maxChartOperations,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          tooth: { type: "string", enum: toothIds },
          procedure: { type: "string", enum: Object.keys(procedures) },
          status: { type: "string", enum: ["", ...Object.keys(procedureStatuses)] },
          surfaces: { type: "array", items: { type: "string", enum: Object.keys(surfaces) }, maxItems: 6 },
        },
        required: ["tooth", "procedure", "status", "surfaces"],
      },
    },
    message: { type: "string" },
    heard: { type: "string" },
  },
  required: ["action", "operations", "message", "heard"],
};
