import type { CSSProperties, ReactNode } from "react";
import { radius } from "../../theme/tokens.ts";
import { FONT_STACK } from "../../theme/tokens.ts";
import { useStage } from "../context.tsx";
import { lerp, progress } from "../motion.ts";

/**
 * The blog's code block as a window: a muted header (file name left, language right) over the shiki
 * surface, with the blog's border and radius scale. Used by code and terminal scenes.
 */
export const WindowCard: React.FC<{
  t: number;
  at: number;
  width: number;
  /** Body height in px (header and footer are added). */
  bodyHeight: number;
  title?: string | undefined;
  right?: string | undefined;
  footer?: ReactNode;
  footerHeight?: number;
  /** 0..1: how much the footer strip is drawn (it is reserved from the start so the card never resizes). */
  footerReveal?: number;
  children: ReactNode;
}> = ({ t, at, width, bodyHeight, title, right, footer, footerHeight = 0, footerReveal = 1, children }) => {
  const { layout, theme } = useStage();
  const { px, sp } = layout;
  const p = progress(t, at, 24);
  const r = radius("lg", sp(4));
  const border = `${px(2)}px solid ${theme.border}`;
  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: sp(8),
    padding: `0 ${sp(3)}px`,
    background: theme.code.header,
    color: theme.code.headerFg,
    fontFamily: FONT_STACK.mono,
    fontSize: px(24),
    borderBottom: border,
    flex: "none",
  };
  return (
    <div
      style={{
        width,
        display: "flex",
        flexDirection: "column",
        borderRadius: r,
        border,
        overflow: "hidden",
        background: theme.code.bg,
        opacity: p,
        transform: `translateY(${lerp(px(32), 0, p)}px) scale(${lerp(0.985, 1, p)})`,
        boxShadow: theme.mode === "light" ? `0 ${px(8)}px ${px(40)}px rgba(0,0,0,0.06)` : "none",
      }}
    >
      <div style={headerStyle}>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title ?? ""}</span>
        <span style={{ opacity: 0.8 }}>{right ?? ""}</span>
      </div>
      <div style={{ height: bodyHeight, position: "relative" }}>{children}</div>
      {footer !== undefined && (
        <div
          style={{
            height: footerHeight,
            flex: "none",
            borderTop: `${px(2)}px solid color-mix(in srgb, ${theme.border} ${Math.round(footerReveal * 100)}%, transparent)`,
            background: `color-mix(in srgb, ${theme.code.header} ${Math.round(footerReveal * 100)}%, transparent)`,
            color: theme.foreground,
            display: "flex",
            alignItems: "center",
            padding: `0 ${sp(3)}px`,
            position: "relative",
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
};
