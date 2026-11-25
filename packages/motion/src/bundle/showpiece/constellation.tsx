import type { ClosingProps, IntroProps } from "./kit.ts";

/** STUB: replaced by the real variant. */
export const ConstellationIntro: React.FC<IntroProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.title} (constellation)</div>;
export const ConstellationClosing: React.FC<ClosingProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.cta} (constellation)</div>;
