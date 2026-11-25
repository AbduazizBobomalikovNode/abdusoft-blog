import { CODE_LINE_HEIGHT, fitCode, MONO_ADVANCE } from "../../fit.ts";
import type { HighlightedLines } from "../../highlight.ts";
import type { CodeScene as CodeSceneData } from "../../schema/storyboard.ts";
import type { CodeTiming } from "../../timeline.ts";
import { typedCount } from "../../timing.ts";
import { FONT_STACK } from "../../theme/tokens.ts";
import { Caret, TokenSpans, tokenLength } from "../components/TokenLine.tsx";
import { WindowCard } from "../components/WindowCard.tsx";
import { useStage } from "../context.tsx";
import { clamp01, easeInOut, lerp, progress } from "../motion.ts";

export const CodeScene: React.FC<{ scene: CodeSceneData; timing: CodeTiming; t: number; lines: HighlightedLines }> = ({ scene, timing, t, lines }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;

  const lineCount = lines.length;
  const lens = lines.map(tokenLength);
  const maxChars = Math.max(1, ...lens);
  const labels = (scene.steps ?? []).map((s) => s.label);
  const hasFooter = labels.some((l) => l !== undefined);
  const headerH = sp(8);
  const footerH = hasFooter ? sp(9) : 0;
  const padX = sp(4);
  const padY = sp(3);
  const border = px(2);
  const digits = String(lineCount).length;

  const fits = (cardW: number) => {
    const fs = fitCode({
      lineCount,
      maxChars,
      digits,
      width: (cardW - 2 * padX) / layout.unit,
      height: (layout.content.height - headerH - footerH - 2 * padY - 2 * border) / layout.unit,
    });
    return px(fs);
  };
  const fsFull = fits(layout.content.width);
  const gutterW = Math.ceil(digits * fsFull * MONO_ADVANCE) + sp(3);
  const wanted = gutterW + 2 * padX + Math.ceil(maxChars * fsFull * MONO_ADVANCE) + sp(6);
  const cardW = Math.min(layout.content.width, Math.max(px(1200), Math.ceil(wanted / 8) * 8));
  const fs = fits(cardW);
  const lineH = fs * CODE_LINE_HEIGHT;
  const bodyH = Math.ceil(lineCount * lineH + 2 * padY);

  // typing state
  const typing = timing.typing;
  const typed = typing ? typedCount(typing.schedule, t - typing.startAt) : Number.POSITIVE_INFINITY;
  const typeEnd = typing ? typing.startAt + (typing.schedule.at(-1) ?? 0) : 0;

  // highlight state
  const steps = timing.steps;
  const k = steps.reduce((acc, s, i) => (t >= s.start ? i : acc), -1);
  const cur = k >= 0 ? (steps[k] as (typeof steps)[number]) : null;
  const prev = k > 0 ? (steps[k - 1] as (typeof steps)[number]) : null;
  const move = cur ? progress(t, cur.start, timing.moveFrames, easeInOut) : 0;
  const inRange = (s: { from: number; to: number } | null, line: number) => (s === null ? 1 : line >= s.from && line <= s.to ? 1 : 0);
  const band = cur
    ? {
        top: lerp((prev ?? cur).from, cur.from, prev ? move : 1),
        bottom: lerp((prev ?? cur).to, cur.to, prev ? move : 1),
        opacity: prev ? 1 : move,
      }
    : null;

  let g = 0;
  let caretLine = -1;
  const starts: number[] = [];
  lens.forEach((len, i) => {
    starts.push(g);
    if (typing && typed >= g && typed <= g + len) caretLine = i;
    g += len + 1;
  });
  const caretOpacity = !typing ? 0 : t < typeEnd ? 1 : t < typeEnd + 48 ? (Math.floor((t - typeEnd) / 16) % 2 === 0 ? 1 : 0) : 0;

  const footer = hasFooter ? (
    <>
      {(scene.steps ?? []).map((s, i) => {
        const st = steps[i];
        if (!st || s.label === undefined) return null;
        const inP = progress(t, st.start + 4, 12);
        const outP = progress(t, st.end - 10, 10);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: padX * 0.75,
              right: padX * 0.75,
              display: "flex",
              alignItems: "baseline",
              gap: sp(2),
              opacity: clamp01(inP) * (1 - outP),
              transform: `translateY(${lerp(px(8), 0, inP)}px)`,
              fontSize: px(28),
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontFamily: FONT_STACK.mono, fontSize: px(24), color: theme.accentText }}>{`${i + 1}/${steps.length}`}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</span>
          </div>
        );
      })}
    </>
  ) : undefined;

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
      <WindowCard t={t} at={timing.cardAt} width={cardW} bodyHeight={bodyH} title={scene.fileName} right={scene.language} footer={footer} footerHeight={footerH} footerReveal={steps[0] ? progress(t, steps[0].start - 6, 14) : 1}>
        {band && (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: padY + (band.top - 1) * lineH,
              height: (band.bottom - band.top + 1) * lineH,
              background: theme.accentWash,
              opacity: band.opacity,
            }}
          >
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: px(4), background: theme.accent }} />
          </div>
        )}
        <div style={{ position: "absolute", left: 0, right: 0, top: padY, fontFamily: FONT_STACK.mono, fontSize: fs, lineHeight: `${lineH}px` }}>
          {lines.map((tokens, i) => {
            const n = i + 1;
            const dim = cur ? lerp(inRange(prev, n), inRange(cur, n), move) : 1;
            const opacity = lerp(theme.dim, 1, dim);
            const visible = Math.max(0, Math.min(lens[i] as number, typed - (starts[i] as number)));
            const started = !typing || typed >= (starts[i] as number);
            return (
              <div key={i} style={{ height: lineH, display: "flex", whiteSpace: "pre", paddingLeft: padX, opacity: started ? opacity : 0 }}>
                <span style={{ width: gutterW, flex: "none", textAlign: "right", paddingRight: sp(3), color: theme.code.gutter, fontVariantNumeric: "tabular-nums" }}>
                  {n}
                </span>
                <span style={{ color: theme.code.fg }}>
                  <TokenSpans tokens={tokens} visible={typing ? visible : undefined} fallback={theme.code.fg} />
                  {i === caretLine && <Caret color={theme.accentText} height={lineH * 0.62} width={px(4)} opacity={caretOpacity} />}
                </span>
              </div>
            );
          })}
        </div>
      </WindowCard>
    </div>
  );
};
