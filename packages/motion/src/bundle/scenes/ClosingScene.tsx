import type { ClosingScene as ClosingSceneData } from "../../schema/storyboard.ts";
import type { ClosingTiming } from "../../timeline.ts";
import { useStage } from "../context.tsx";
import { AuroraClosing } from "../showpiece/aurora.tsx";
import { BlueprintClosing } from "../showpiece/blueprint.tsx";
import { ConstellationClosing } from "../showpiece/constellation.tsx";
import { BootClosing } from "../showpiece/boot.tsx";
import { SignalClosing } from "../showpiece/signal.tsx";
import { SlamClosing } from "../showpiece/slam.tsx";

/** Dispatches to the selected closing variant (all variants live in ../showpiece/). */
export const ClosingScene: React.FC<{ scene: ClosingSceneData; timing: ClosingTiming; t: number }> = (props) => {
  const { siteName } = useStage();
  const p = { ...props, siteName: props.scene.siteName ?? siteName };
  switch (props.timing.variant) {
    case "aurora":
      return <AuroraClosing {...p} />;
    case "blueprint":
      return <BlueprintClosing {...p} />;
    case "constellation":
      return <ConstellationClosing {...p} />;
    case "boot":
      return <BootClosing {...p} />;
    case "signal":
      return <SignalClosing {...p} />;
    case "slam":
      return <SlamClosing {...p} />;
  }
};
