import "mind-elixir/style.css";
import { forwardRef } from "react";

import { MindMap as BaseMindMap, MindMapControls, useMindMap } from "./mindmap";
import type { MindMapProps, MindMapRef } from "./mindmap-types";

export { MindMapControls, useMindMap };
export type { MindMapProps, MindMapRef } from "./mindmap-types";

export const MindMap = forwardRef<MindMapRef, MindMapProps>(function MindMapRuntime(
  props,
  ref,
) {
  return <BaseMindMap ref={ref} {...props} />;
});

export default MindMap;
