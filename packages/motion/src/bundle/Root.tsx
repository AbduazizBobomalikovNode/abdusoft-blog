import { Composition } from "remotion";
import { FORMATS } from "../layout.ts";
import { COMPOSITION_ID, type RenderProps, renderPropsSchema } from "../props.ts";
import { computeTimeline } from "../timeline.ts";
import { FPS } from "../timing.ts";
import { Explainer } from "./Explainer.tsx";
import "./fonts.ts";

/** Placeholder storyboard so the composition registers; real renders always pass their own props. */
const defaultProps: RenderProps = {
  storyboard: {
    version: 1,
    title: "placeholder",
    theme: "dark",
    siteName: "abdusoft",
    format: "landscape",
    defaultTransition: "fade",
    scenes: [{ type: "title", title: "abdusoft" }],
  },
  highlights: { code: {}, terminal: {} },
};

export const Root: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={Explainer}
    schema={renderPropsSchema}
    defaultProps={defaultProps}
    width={FORMATS.landscape.width}
    height={FORMATS.landscape.height}
    fps={FPS}
    durationInFrames={FPS * 3}
    calculateMetadata={({ props }) => {
      const sb = renderPropsSchema.parse(props).storyboard;
      const tl = computeTimeline(sb);
      const f = FORMATS[sb.format];
      return { durationInFrames: Math.max(1, tl.totalFrames), width: f.width, height: f.height, fps: f.fps };
    }}
  />
);
