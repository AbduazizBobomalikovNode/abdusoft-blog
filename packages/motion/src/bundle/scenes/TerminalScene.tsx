import { CODE_LINE_HEIGHT, fitMono, MONO_ADVANCE } from "../../fit.ts";
import type { Token } from "../../highlight.ts";
import type { TerminalScene as TerminalSceneData } from "../../schema/storyboard.ts";
import type { TerminalTiming } from "../../timeline.ts";
import { typedCount } from "../../timing.ts";
import { FONT_STACK } from "../../theme/tokens.ts";
import { Caret, TokenSpans } from "../components/TokenLine.tsx";
import { WindowCard } from "../components/WindowCard.tsx";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

const PROMPT = "$ ";

export const TerminalScene: React.FC<{
  scene: TerminalSceneData;
  timing: TerminalTiming;
  t: number;
  commandTokens: Record<string, Token[]>;
}> = ({ scene, timing, t, commandTokens }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const rows = scene.lines.length + 1; // + the idle prompt that blinks at the end
  const maxChars = Math.max(
    PROMPT.length + 8,
    ...scene.lines.map((l) => (l.kind === "command" ? PROMPT.length : 0) + [...l.text].length),
  );
  const headerH = sp(8);
  const padX = sp(4);
  const padY = sp(3);
  const border = px(2);
  const fs = px(
    fitMono({
      lineCount: rows,
      maxChars,
      width: (layout.content.width - 2 * padX) / layout.unit,
      height: (layout.content.height - headerH - 2 * padY - 2 * border) / layout.unit,
    }),
  );
  const lineH = fs * CODE_LINE_HEIGHT;
  const cardW = Math.min(layout.content.width, Math.max(px(1200), Math.ceil((2 * padX + maxChars * fs * MONO_ADVANCE + sp(8)) / 8) * 8));
  const bodyH = Math.ceil(Math.max(rows, 6) * lineH + 2 * padY);

  // which command is being typed / is last started
  let activeCmd = -1;
  scene.lines.forEach((l, i) => {
    const e = timing.entries[i];
    if (l.kind === "command" && e && t >= e.startAt) activeCmd = i;
  });
  const active = activeCmd >= 0 ? (timing.entries[activeCmd] as (typeof timing.entries)[number]) : null;
  const typingNow = active !== null && active.enterAt !== null && t < active.enterAt;
  const lastEntry = timing.entries.at(-1);
  const allDone = lastEntry !== undefined && t >= lastEntry.startAt + 6;
  const blink = Math.floor(t / 16) % 2 === 0 ? 1 : 0;

  const toneColor = (tone: string | undefined): string => {
    if (tone === "success") return theme.tone.success;
    if (tone === "error") return theme.tone.error;
    return theme.code.fg;
  };

  return (
    <div
      style={{
        position: "absolute",
        left: layout.content.x,
        top: layout.content.y,
        width: layout.content.width,
        height: layout.content.height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <WindowCard t={t} at={timing.cardAt} width={cardW} bodyHeight={bodyH} title={scene.title ?? "terminal"} right="bash">
        <div style={{ position: "absolute", left: padX, right: padX, top: padY, fontFamily: FONT_STACK.mono, fontSize: fs, lineHeight: `${lineH}px` }}>
          {scene.lines.map((l, i) => {
            const e = timing.entries[i];
            if (!e || t < e.startAt) return <div key={i} style={{ height: lineH }} />;
            if (l.kind === "command") {
              const n = e.schedule ? typedCount(e.schedule, t - e.startAt) : 0;
              const tokens = commandTokens[String(i)] ?? [{ content: l.text }];
              const isActive = i === activeCmd && typingNow;
              return (
                <div key={i} style={{ height: lineH, whiteSpace: "pre", color: theme.code.fg }}>
                  <span style={{ color: theme.accentText }}>{PROMPT}</span>
                  <TokenSpans tokens={tokens} visible={n} fallback={theme.code.fg} />
                  {isActive && <Caret color={theme.accentText} height={lineH * 0.62} width={px(4)} opacity={1} />}
                </div>
              );
            }
            const p = progress(t, e.startAt, 10);
            return (
              <div
                key={i}
                style={{
                  height: lineH,
                  whiteSpace: "pre",
                  color: toneColor(l.tone),
                  opacity: p * (l.tone === "muted" ? 0.6 : 1),
                  transform: `translateY(${lerp(px(8), 0, p)}px)`,
                }}
              >
                {l.text}
              </div>
            );
          })}
          {allDone && (
            <div style={{ height: lineH, whiteSpace: "pre" }}>
              <span style={{ color: theme.accentText }}>{PROMPT}</span>
              <Caret color={theme.accentText} height={lineH * 0.62} width={px(4)} opacity={blink} />
            </div>
          )}
        </div>
      </WindowCard>
    </div>
  );
};
