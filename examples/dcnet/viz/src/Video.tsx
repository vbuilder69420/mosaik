import { Composition } from "remotion";
import { DcNetDemo } from "./DcNetDemo";

export const DcNetVideo: React.FC = () => {
  return (
    <Composition
      id="DcNetDemo"
      component={DcNetDemo}
      durationInFrames={30 * 92} // 92 seconds at 30fps
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
