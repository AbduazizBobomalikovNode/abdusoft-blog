import type { CSSProperties } from "react";
import type { Token } from "../../highlight.ts";

const FONT_ITALIC = 1;
const FONT_BOLD = 2;
const FONT_UNDERLINE = 4;

export function tokenStyle(token: Token, fallback: string): CSSProperties {
  const fs = token.fontStyle ?? 0;
  return {
    color: token.color ?? fallback,
    ...(fs & FONT_ITALIC ? { fontStyle: "italic" } : {}),
    ...(fs & FONT_BOLD ? { fontWeight: 600 } : {}),
    ...(fs & FONT_UNDERLINE ? { textDecoration: "underline" } : {}),
  };
}

export const tokenLength = (tokens: readonly Token[]): number => tokens.reduce((n, t) => n + [...t.content].length, 0);

/**
 * Tokens as React text nodes, optionally cut after `visible` code points (typing). Text is only ever a
 * React child, so it is escaped; nothing from a storyboard becomes markup.
 */
export const TokenSpans: React.FC<{ tokens: readonly Token[]; visible?: number; fallback: string }> = ({ tokens, visible = Infinity, fallback }) => {
  let left = visible;
  const out: React.ReactNode[] = [];
  tokens.forEach((tok, i) => {
    if (left <= 0) return;
    const chars = [...tok.content];
    const text = chars.length <= left ? tok.content : chars.slice(0, left).join("");
    left -= chars.length;
    out.push(
      <span key={i} style={tokenStyle(tok, fallback)}>
        {text}
      </span>,
    );
  });
  return <>{out}</>;
};

/** Zero-width inline anchor that draws a caret bar; does not shift the text around it. */
export const Caret: React.FC<{ color: string; height: number; width: number; opacity: number }> = ({ color, height, width, opacity }) => (
  <span style={{ position: "relative", display: "inline-block", width: 0, height: 0 }}>
    <span style={{ position: "absolute", left: width * 0.5, top: -height * 0.78, width, height, background: color, opacity, borderRadius: width / 3 }} />
  </span>
);
