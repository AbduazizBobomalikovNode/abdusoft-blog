import { z } from "zod";
import { highlightsSchema } from "./highlight.ts";
import { storyboardSchema } from "./schema/storyboard.ts";

/** Input props of the `Explainer` composition: a validated storyboard plus its precomputed highlights. */
export const renderPropsSchema = z.strictObject({
  storyboard: storyboardSchema,
  highlights: highlightsSchema,
});
export type RenderProps = z.infer<typeof renderPropsSchema>;

export const COMPOSITION_ID = "Explainer";
