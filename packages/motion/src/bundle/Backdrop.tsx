import type { Theme } from "../theme/tokens.ts";

/**
 * Ambient backdrop of a style preset, drawn once under every scene (nothing for the default preset).
 * Purely a function of the absolute frame: CSS gradients only, no filters, no canvas, no randomness.
 */
export const Backdrop: React.FC<{ theme: Theme; frame: number; width: number; height: number }> = ({ theme, frame, width, height }) => {
  const { backdrop } = theme;
  if (!backdrop.mesh && !backdrop.grid) return null;
  const layers: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  const dark = theme.mode === "dark";
  const a = backdrop.ambient;
  if (backdrop.mesh) {
    // The mesh drifts in 10-frame steps of at most a few pixels (imperceptible stepping): frames in between
    // paint identically, which keeps the preset's render cost close to the default preset.
    const t = Math.floor(frame / 10) * (10 / 30);
    const blob = (cx: number, cy: number, rx: number, color: string, pct: number): string =>
      `radial-gradient(${rx}px ${rx * 0.8}px at ${cx}px ${cy}px, color-mix(in srgb, ${color} ${pct}%, transparent), transparent 70%)`;
    const w = width;
    const h = height;
    layers.push(
      blob(w * (0.12 + 0.025 * a * Math.sin(t * 0.5)), h * (0.1 + 0.03 * a * Math.cos(t * 0.4)), w * 0.55, theme.accent, dark ? 42 : 20),
      blob(w * (0.9 + 0.02 * a * Math.cos(t * 0.45)), h * (0.95 + 0.025 * a * Math.sin(t * 0.35)), w * 0.5, theme.accent2, dark ? 34 : 18),
      blob(w * (0.62 + 0.04 * a * Math.sin(t * 0.3 + 1)), h * (0.4 + 0.04 * a * Math.cos(t * 0.3)), w * 0.32, theme.accent, dark ? 14 : 8),
    );
    sizes.push("100% 100%", "100% 100%", "100% 100%");
    positions.push("0 0", "0 0", "0 0");
  }
  if (backdrop.grid) {
    const minor = Math.round(width / 48);
    const major = minor * 5;
    // Static on purpose: an unchanged layer is not repainted from frame to frame; a drifting grid made
    // blueprint/neon renders several times slower.
    const drift = 0;
    layers.push(
      `linear-gradient(${backdrop.grid.major} 2px, transparent 2px)`,
      `linear-gradient(90deg, ${backdrop.grid.major} 2px, transparent 2px)`,
      `linear-gradient(${backdrop.grid.color} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${backdrop.grid.color} 1px, transparent 1px)`,
    );
    sizes.push(`${major}px ${major}px`, `${major}px ${major}px`, `${minor}px ${minor}px`, `${minor}px ${minor}px`);
    positions.push(`0 ${drift}px`, `${drift}px 0`, `0 ${drift}px`, `${drift}px 0`);
  }
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: layers.join(", "),
        backgroundSize: sizes.join(", "),
        backgroundPosition: positions.join(", "),
        backgroundRepeat: "repeat",
      }}
    />
  );
};
