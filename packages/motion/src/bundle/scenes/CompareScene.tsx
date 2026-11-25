import type { CompareScene as D } from "../../schema/storyboard.ts";
import type { CompareTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const CompareScene: React.FC<{ scene: D; timing: CompareTiming; t: number }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
