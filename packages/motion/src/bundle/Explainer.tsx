import { useMemo } from "react";
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { Backdrop } from "./Backdrop.tsx";
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
import { ClosingScene } from "./scenes/ClosingScene.tsx";
import { CodeDiffScene } from "./scenes/CodeDiffScene.tsx";
import { CompareScene } from "./scenes/CompareScene.tsx";
import { DiagramScene } from "./scenes/DiagramScene.tsx";
import { IntroScene } from "./scenes/IntroScene.tsx";
import { QuoteScene } from "./scenes/QuoteScene.tsx";
import { StatScene } from "./scenes/StatScene.tsx";
import { StepsScene } from "./scenes/StepsScene.tsx";
import { plainLines } from "../highlight.ts";
import { parseDiff } from "../schema/storyboard.ts";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * Wraps a scene: drives transitions in and out and hands the scene its content clock.
 *
 *  - fade:  cross-dissolve
 *  - slide: small horizontal drift while fading
 *  - wipe:  the incoming scene is revealed left to right over an opaque plate, with an accent edge
 *  - push:  the incoming scene pushes the outgoing one out to the left
 *  - zoom:  zoom-through: the outgoing scene rushes toward the camera as the incoming one settles in
 */
const SceneShell: React.FC<{ timing: SceneTiming; children: (t: number) => React.ReactNode }> = ({ timing, children }) => {
  const frame = useCurrentFrame();
  const { layout, theme } = useStage();
  const { px, width } = layout;
  const inP = timing.enter.frames > 0 ? interpolate(frame, [0, timing.enter.frames], [0, 1], { ...clamp, easing: easeInOut }) : 1;
  const outStart = timing.durationFrames - timing.exit.frames;
  const outP = timing.exit.frames > 0 ? interpolate(frame, [outStart, timing.durationFrames], [0, 1], { ...clamp, easing: easeInOut }) : 0;
  const enter = timing.enter.kind;
  const exit = timing.exit.kind;
  const content = children(frame - timing.leadFrames);

  let opacity = 1;
  const tf: string[] = [];
  let clipPath: string | undefined;
  if (enter === "fade" || enter === "slide") opacity *= inP;
  if (exit === "fade" || exit === "slide") opacity *= 1 - outP;
  if (enter === "slide") tf.push(`translateX(${(1 - inP) * px(80)}px)`);
  if (exit === "slide") tf.push(`translateX(${-outP * px(80)}px)`);
  if (enter === "push" && inP < 1) tf.push(`translateX(${(1 - inP) * width}px)`);
  if (exit === "push" && outP > 0) tf.push(`translateX(${-outP * width}px)`);
  if (enter === "zoom" && inP < 1) {
    const p = interpolate(inP, [0.3, 1], [0, 1], clamp);
    opacity *= p;
    tf.push(`scale(${0.88 + 0.12 * p})`);
  }
  if (exit === "zoom" && outP > 0) {
    const p = interpolate(outP, [0, 0.7], [0, 1], clamp);
    opacity *= 1 - p;
    tf.push(`scale(${1 + 0.2 * p})`);
  }
  const wiping = enter === "wipe" && inP < 1;
  if (wiping) clipPath = `inset(0 ${(1 - inP) * 100}% 0 0)`;
  return (
    <AbsoluteFill style={{ opacity, transform: tf.length > 0 ? tf.join(" ") : undefined, clipPath }}>
      {wiping && <AbsoluteFill style={{ background: theme.background }} />}
      {wiping && <Backdrop theme={theme} frame={frame + timing.startFrame} width={layout.width} height={layout.height} />}
      {content}
      {wiping && (
        <div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: px(6), background: theme.gradient, opacity: 1 - inP * 0.4 }} />
      )}
    </AbsoluteFill>
  );
};

export const Explainer: React.FC<RenderProps> = ({ storyboard, highlights }) => {
  const frame = useCurrentFrame();
  const layout = useMemo(() => createLayout(storyboard.format), [storyboard.format]);
  const theme = useMemo(() => createTheme(storyboard.theme, storyboard.accent, storyboard.preset ?? "default"), [storyboard.theme, storyboard.accent, storyboard.preset]);
  const timeline = useMemo(() => computeTimeline(storyboard), [storyboard]);
  const { px, sp } = layout;

  const outro = timeline.scenes.find((s) => s.type === "outro" || s.type === "closing");
  const wordmarkOpacity = outro
    ? interpolate(frame, [outro.startFrame + outro.leadFrames, outro.startFrame + outro.leadFrames + 12], [OG_CARD.wordmarkOpacity, 0], clamp)
    : OG_CARD.wordmarkOpacity;
  const current = timeline.scenes.reduce((acc, s) => (frame >= s.startFrame + s.leadFrames ? s.index : acc), 0);
  const progress = Math.min(1, frame / Math.max(1, timeline.totalFrames - 1));

  return (
    <StageProvider value={{ layout, theme, siteName: storyboard.siteName }}>
      <AbsoluteFill style={{ background: theme.background, color: theme.foreground, fontFamily: FONT_STACK.sans, WebkitFontSmoothing: "antialiased" }}>
        <Backdrop theme={theme} frame={frame} width={layout.width} height={layout.height} />

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
                    case "intro":
                      return c.type === "intro" ? <IntroScene scene={scene} timing={c} t={t} /> : null;
                    case "closing":
                      return c.type === "closing" ? <ClosingScene scene={scene} timing={c} t={t} /> : null;
                    case "diagram":
                      return c.type === "diagram" ? <DiagramScene scene={scene} timing={c} t={t} /> : null;
                    case "compare":
                      return c.type === "compare" ? <CompareScene scene={scene} timing={c} t={t} /> : null;
                    case "stat":
                      return c.type === "stat" ? <StatScene scene={scene} timing={c} t={t} /> : null;
                    case "steps":
                      return c.type === "steps" ? <StepsScene scene={scene} timing={c} t={t} /> : null;
                    case "quote":
                      return c.type === "quote" ? <QuoteScene scene={scene} timing={c} t={t} /> : null;
                    case "codeDiff":
                      return c.type === "codeDiff" ? (
                        <CodeDiffScene scene={scene} timing={c} t={t} lines={highlights.code[String(timing.index)] ?? plainLines(parseDiff(scene.diff).map((l) => l.text).join("\n"))} />
                      ) : null;
                  }
                }}
              </SceneShell>
            </Sequence>
          );
        })}

        {/* persistent brand row: above every scene so transitions never move or hide it */}
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

        {/* progress hairline */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: sp(0.5), background: theme.border }}>
          <div style={{ width: `${progress * 100}%`, height: "100%", background: theme.preset === "default" ? theme.accent : theme.gradient }} />
        </div>
      </AbsoluteFill>
    </StageProvider>
  );
};
