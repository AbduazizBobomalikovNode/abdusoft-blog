import { z } from "zod";
import { storyboardSchema } from "./schema/storyboard.ts";

/**
 * JSON Schema (draft 2020-12) of the storyboard INPUT, to hand to an assistant. It describes shape,
 * enums and per-field limits; cross-field and timing rules (code line ranges, scene durations, the
 * 60 s total) are enforced by `validateStoryboard` and explained in its messages.
 */
export function storyboardJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(storyboardSchema, { io: "input", target: "draft-2020-12" }) as Record<string, unknown>;
  return {
    ...schema,
    title: "abdusoft blog motion storyboard",
    description:
      "Storyboard for a silent animated explainer (max 60 s, 1920x1080 @ 30 fps). Pure data: the engine renders it deterministically with no AI and no network access.",
  };
}
