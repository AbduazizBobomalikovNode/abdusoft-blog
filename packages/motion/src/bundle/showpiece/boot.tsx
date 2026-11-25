import type { ClosingProps, IntroProps } from "./kit.ts";

/** STUB: replaced by the real variant. */
export const BootIntro: React.FC<IntroProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.title} (boot)</div>;
export const BootClosing: React.FC<ClosingProps> = ({ scene }) => <div style={{ position: "absolute", left: 200, top: 300, fontSize: 64 }}>{scene.cta} (boot)</div>;
