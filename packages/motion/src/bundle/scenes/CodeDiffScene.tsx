import { CODE_LINE_HEIGHT, fitCode, MONO_ADVANCE } from "../../fit.ts";
import type { HighlightedLines } from "../../highlight.ts";
import { type CodeDiffScene as D, parseDiff } from "../../schema/storyboard.ts";
import type { CodeDiffTiming } from "../../timeline.ts";
import { FONT_STACK } from "../../theme/tokens.ts";
import { TokenSpans, tokenLength } from "../components/TokenLine.tsx";
import { WindowCard } from "../components/WindowCard.tsx";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

export const CodeDiffScene: React.FC<{ scene: D; timing: CodeDiffTiming; t: number; lines: HighlightedLines }> = ({ scene, timing, t, lines }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const ops = parseDiff(scene.diff);
  const lineCount = ops.length;
  const maxChars = Math.max(1, ...ops.map((o, i) => (lines[i] ? tokenLength(lines[i] as never) : o.text.length)));
  const hasLabel = scene.label !== undefined;
  const headerH = sp(8);
  const footerH = hasLabel ? sp(9) : 0;
  const padX = sp(4);
  const padY = sp(3);
  const border = px(2);
  const markW = px(64);

  const fits = (cardW: number): number =>
    px(
      fitCode({
        lineCount,
        maxChars,
        digits: 1,
        width: (cardW - 2 * padX - markW) / layout.unit,
        height: (layout.content.height - headerH - footerH - 2 * padY - 2 * border) / layout.unit,
      }),
    );
  const fsFull = fits(layout.content.width);
  const wanted = markW + 2 * padX + Math.ceil(maxChars * fsFull * MONO_ADVANCE) + sp(6);
  const cardW = Math.min(layout.content.width, Math.max(px(1200), Math.ceil(wanted / 8) * 8));
  const fs = fits(cardW);
  const lineH = fs * CODE_LINE_HEIGHT;
  const bodyH = Math.ceil(lineCount * lineH + 2 * padY);

  const removeP = progress(t, timing.removeAt, 16);
  const strike = progress(t, timing.removeAt + 14, 14);
  const anyAdd = timing.addAt.some((a) => a !== null);
  const firstAdd = timing.addAt.find((a) => a !== null) ?? 0;
  const ctxDim = anyAdd ? lerp(1, 0.78, progress(t, firstAdd - 6, 14)) : 1;
  const err = theme.tone.error;
  const ok = theme.tone.success;
  const wash = (c: string, pct: number): string => `color-mix(in srgb, ${c} ${pct}%, transparent)`;

  const footer = hasLabel ? (
    <div style={{ position: "absolute", left: padX * 0.75, right: padX * 0.75, display: "flex", alignItems: "baseline", gap: sp(2), fontSize: px(28), whiteSpace: "nowrap", opacity: progress(t, timing.labelAt, 16), transform: `translateY(${lerp(px(8), 0, progress(t, timing.labelAt, 16))}px)` }}>
      <span style={{ fontFamily: FONT_STACK.mono, fontSize: px(24), color: theme.accentText }}>diff</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{scene.label}</span>
    </div>
  ) : undefined;

  return (
    <div style={{ position: "absolute", left: layout.content.x, top: layout.content.y, width: layout.content.width, height: layout.content.height, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <WindowCard t={t} at={timing.cardAt} width={cardW} bodyHeight={bodyH} title={scene.fileName} right={scene.language} footer={footer} footerHeight={footerH} footerReveal={hasLabel ? progress(t, timing.labelAt - 6, 14) : 1}>
        <div style={{ position: "absolute", left: 0, right: 0, top: padY, fontFamily: FONT_STACK.mono, fontSize: fs, lineHeight: `${lineH}px` }}>
          {ops.map((o, i) => {
            const tokens = lines[i] ?? [];
            const addAt = timing.addAt[i];
            const added = o.op === "add";
            const removed = o.op === "remove";
            const inP = added ? progress(t, addAt ?? 0, 16) : 1;
            const h = added ? lineH * inP : lineH;
            const rowOpacity = added ? inP : removed ? lerp(1, 0.72, strike) : o.op === "context" ? ctxDim : 1;
            const bg = removed ? wash(err, 20 * removeP) : added ? wash(ok, 22) : "transparent";
            const barColor = removed ? err : ok;
            const marker = removed ? (removeP > 0.2 ? "-" : "") : added ? "+" : "";
            return (
              <div key={i} style={{ height: h, overflow: "hidden", position: "relative", background: bg }}>
                <div style={{ height: lineH, display: "flex", whiteSpace: "pre", paddingLeft: padX, opacity: rowOpacity, transform: added ? `translateX(${lerp(-px(40), 0, inP)}px)` : undefined }}>
                  {(removed || added) && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: px(4), background: barColor, opacity: removed ? removeP : 1 }} />}
                  <span style={{ width: markW, flex: "none", textAlign: "center", paddingRight: sp(1), color: removed ? err : ok, fontWeight: 700 }}>{marker}</span>
                  <span style={{ color: theme.code.fg, textDecoration: removed && strike > 0.5 ? "line-through" : undefined, textDecorationColor: removed ? err : undefined }}>
                    <TokenSpans tokens={tokens} fallback={theme.code.fg} />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </WindowCard>
    </div>
  );
};
