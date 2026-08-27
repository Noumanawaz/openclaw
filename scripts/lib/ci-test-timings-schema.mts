import { z } from "zod";

const secondsMap = z.record(z.string().min(1), z.number().int().positive());

export const ciTestTimingsSchema = z.strictObject({
  compactGroupSeconds: z.strictObject({ blacksmith: secondsMap, github: secondsMap }),
  source: z.string().min(1),
  uiE2e: z.strictObject({
    fileSeconds: secondsMap,
    perFileOverheadSeconds: z.number().min(0).max(5),
  }),
  updatedAt: z.iso.date(),
  version: z.literal(1),
});

export type CiTestTimings = z.infer<typeof ciTestTimingsSchema>;
