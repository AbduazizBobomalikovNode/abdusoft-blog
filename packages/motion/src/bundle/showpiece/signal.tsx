import type { ClosingProps, IntroProps } from "./kit.ts";

/** STUB: replaced by the real variant. */
export const SignalIntro: React.FC<IntroProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.title} (signal)</div>;
export const SignalClosing: React.FC<ClosingProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.cta} (signal)</div>;
