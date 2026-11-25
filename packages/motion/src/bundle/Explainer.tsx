import { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { createLayout } from "../layout.ts";
import type { RenderProps } from "../props.ts";
import { type SceneTiming, computeTimeline } from "../timeline.ts";
import { createTheme, FONT_STACK, OG_CARD } from "../theme/tokens.ts";
import { StageProvider, useStage } from "./context.tsx";
import { easeInOut } from "./motion.ts";
import { BulletsScene } from "./scenes/BulletsScene.tsx";
import { CodeScene } from "./scenes/CodeScene.tsx";
import { OutroScene } from "./scenes/OutroScene.tsx";
import { TerminalScene } from "./scenes/TerminalScene.tsx";
import { TitleScene } from "./scenes/TitleScene.tsx";
import { plainLines } from "../highlight.ts";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Wraps a scene: drives transitions in and out and hands the scene its content clock. */
const SceneShell: React.FC<{ timing: SceneTiming; children: (t: number) => React.ReactNode }> = ({ timing, children }) => {
  const frame = useCurrentFrame();
  const { px } = useStage().layout;
  const inP = timing.enter.frames > 0 ? interpolate(frame, [0, timing.enter.frames], [0, 1], { ...clamp, easing: easeInOut }) : 1;
  const outStart = timing.durationFrames - timing.exit.frames;
  const outP = timing.exit.frames > 0 ? interpolate(frame, [outStart, timing.durationFrames], [0, 1], { ...clamp, easing: easeInOut }) : 0;
  const slide = timing.enter.kind === "slide" || timing.exit.kind === "slide";
  const dx = (timing.enter.kind === "slide" ? (1 - inP) * px(80) : 0) - (timing.exit.kind === "slide" ? outP * px(80) : 0);
  return (
    <AbsoluteFill style={{ opacity: inP * (1 - outP), transform: slide ? `translateX(${dx}px)` : undefined }}>
      {children(frame - timing.leadFrames)}
    </AbsoluteFill>
  );
};

export const Explainer: React.FC<RenderProps> = ({ storyboard, highlights }) => {
  const frame = useCurrentFrame();
  const layout = useMemo(() => createLayout(storyboard.format), [storyboard.format]);
  const theme = useMemo(() => createTheme(storyboard.theme, storyboard.accent), [storyboard.theme, storyboard.accent]);
  const timeline = useMemo(() => computeTimeline(storyboard), [storyboard]);
  const { px, sp } = layout;

  const outro = timeline.scenes.find((s) => s.type === "outro");
  const wordmarkOpacity = outro
    ? interpolate(frame, [outro.startFrame + outro.leadFrames, outro.startFrame + outro.leadFrames + 12], [OG_CARD.wordmarkOpacity, 0], clamp)
    : OG_CARD.wordmarkOpacity;
  const current = timeline.scenes.reduce((acc, s) => (frame >= s.startFrame + s.leadFrames ? s.index : acc), 0);
  const progress = Math.min(1, frame / Math.max(1, timeline.totalFrames - 1));

  return (
    <StageProvider value={{ layout, theme, siteName: storyboard.siteName }}>
      <AbsoluteFill style={{ background: theme.background, color: theme.foreground, fontFamily: FONT_STACK.sans, WebkitFontSmoothing: "antialiased" }}>
        {/* persistent brand row */}
        <div
          style={{
            position: "absolute",
            left: layout.header.x,
            top: layout.header.y,
            width: layout.header.width,
            height: layout.header.height,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              fontSize: px(28),
              fontWeight: 500,
              letterSpacing: `${OG_CARD.wordmarkLetterSpacingEm}em`,
              textTransform: "uppercase",
              opacity: wordmarkOpacity,
              color: theme.foreground,
            }}
          >
            {storyboard.siteName}
          </span>
          <span style={{ fontFamily: FONT_STACK.mono, fontSize: px(24), color: theme.mutedForeground, fontVariantNumeric: "tabular-nums", letterSpacing: "0.04em" }}>
            {String(current + 1).padStart(2, "0")} / {String(timeline.scenes.length).padStart(2, "0")}
          </span>
        </div>

        {timeline.scenes.map((timing) => {
          const scene = storyboard.scenes[timing.index];
          if (!scene) return null;
          return (
            <Sequence key={timing.index} from={timing.startFrame} durationInFrames={timing.durationFrames} name={`${timing.index + 1} ${scene.type}`}>
              <SceneShell timing={timing}>
                {(t) => {
                  const c = timing.content;
                  switch (scene.type) {
                    case "title":
                      return c.type === "title" ? <TitleScene scene={scene} timing={c} t={t} /> : null;
                    case "bullets":
                      return c.type === "bullets" ? <BulletsScene scene={scene} timing={c} t={t} /> : null;
                    case "code":
                      return c.type === "code" ? (
                        <CodeScene scene={scene} timing={c} t={t} lines={highlights.code[String(timing.index)] ?? plainLines(scene.code)} />
                      ) : null;
                    case "terminal":
                      return c.type === "terminal" ? (
                        <TerminalScene scene={scene} timing={c} t={t} commandTokens={highlights.terminal[String(timing.index)] ?? {}} />
                      ) : null;
                    case "outro":
                      return c.type === "outro" ? <OutroScene scene={scene} timing={c} t={t} /> : null;
                  }
                }}
              </SceneShell>
            </Sequence>
          );
        })}

        {/* progress hairline */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: sp(0.5), background: theme.border }}>
          <div style={{ width: `${progress * 100}%`, height: "100%", background: theme.accent }} />
        </div>
      </AbsoluteFill>
    </StageProvider>
  );
};
