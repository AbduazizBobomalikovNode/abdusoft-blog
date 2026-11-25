import type { QuoteScene as D } from "../../schema/storyboard.ts";
import type { QuoteTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const QuoteScene: React.FC<{ scene: D; timing: QuoteTiming; t: number }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
