import type { ClosingScene, IntroScene } from "../../schema/storyboard.ts";
import type { ClosingTiming, IntroTiming } from "../../timeline.ts";

/**
 * Props every intro variant receives. `t` is the scene's content clock in frames (0 = first frame of the scene's own animation).
 * NOTE: `t` can be NEGATIVE while the scene is fading/wiping in over the previous one: clamp before indexing arrays or repeating strings.
 */
export interface IntroProps {
  scene: IntroScene;
  timing: IntroTiming;
  t: number;
}
/**
 * Props every closing variant receives. After `timing`'s settle point the scene holds for
 * `timing.loopFrames` frames; ambient motion in the hold MUST be periodic with that period
 * (e.g. sin(2 * PI * t / loopFrames * k) for integer k) so the final hold loops seamlessly.
 */
export interface ClosingProps {
  scene: ClosingScene;
  timing: ClosingTiming;
  t: number;
  /** Site name to show (scene.siteName ?? storyboard siteName). */
  siteName: string;
}
