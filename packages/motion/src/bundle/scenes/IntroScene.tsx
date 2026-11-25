import type { IntroScene as IntroSceneData } from "../../schema/storyboard.ts";
import type { IntroTiming } from "../../timeline.ts";
import { AuroraIntro } from "../showpiece/aurora.tsx";
import { BlueprintIntro } from "../showpiece/blueprint.tsx";
import { ConstellationIntro } from "../showpiece/constellation.tsx";
import { BootIntro } from "../showpiece/boot.tsx";
import { SignalIntro } from "../showpiece/signal.tsx";
import { SlamIntro } from "../showpiece/slam.tsx";

/** Dispatches to the selected intro variant (all variants live in ../showpiece/). */
export const IntroScene: React.FC<{ scene: IntroSceneData; timing: IntroTiming; t: number }> = (props) => {
  switch (props.timing.variant) {
    case "aurora":
      return <AuroraIntro {...props} />;
    case "blueprint":
      return <BlueprintIntro {...props} />;
    case "constellation":
      return <ConstellationIntro {...props} />;
    case "boot":
      return <BootIntro {...props} />;
    case "signal":
      return <SignalIntro {...props} />;
    case "slam":
      return <SlamIntro {...props} />;
  }
};
