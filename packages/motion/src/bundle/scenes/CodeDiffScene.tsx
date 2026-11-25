import type { HighlightedLines } from "../../highlight.ts";
import type { CodeDiffScene as D } from "../../schema/storyboard.ts";
import type { CodeDiffTiming } from "../../timeline.ts";

/** STUB: replaced by the real scene. */
export const CodeDiffScene: React.FC<{ scene: D; timing: CodeDiffTiming; t: number; lines: HighlightedLines }> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.type}</div>;
