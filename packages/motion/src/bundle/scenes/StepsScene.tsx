import type { StepsScene as D } from "../../schema/storyboard.ts";
import type { StepsTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const StepsScene: React.FC<{ scene: D; timing: StepsTiming; t: number }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
