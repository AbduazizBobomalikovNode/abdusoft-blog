import type { StatScene as D } from "../../schema/storyboard.ts";
import type { StatTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const StatScene: React.FC<{ scene: D; timing: StatTiming; t: number }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
