import type { DiagramScene as D } from "../../schema/storyboard.ts";
import type { DiagramTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const DiagramScene: React.FC<{ scene: D; timing: DiagramTiming; t: number }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
