import type {
  MindElixirData,
  MindElixirInstance,
  NodeObj,
  Options,
  Theme as MindElixirTheme,
} from "mind-elixir";
import type { ReactNode } from "react";

export interface MindMapContextValue {
  mind: MindElixirInstance | null;
  isLoaded: boolean;
}

export type MindMapData = MindElixirData;

export interface MindMapRef {
  instance: MindElixirInstance | null;
}

export interface MindMapProps {
  children?: ReactNode;
  data?: MindMapData;
  className?: string;
  direction?: 0 | 1 | 2;
  contextMenu?: boolean;
  nodeMenu?: boolean;
  keypress?: boolean;
  locale?: "en" | "zh_CN" | "zh_TW" | "ja" | "pt";
  overflowHidden?: boolean;
  mainLinkStyle?: number;
  theme?: "dark" | "light";
  monochrome?: boolean;
  fit?: boolean;
  readonly?: boolean;
  onChange?: (data: MindMapData, operation: unknown) => void;
  onOperation?: (operation: unknown) => void;
  onSelectNodes?: (nodeObj: NodeObj[]) => void;
  loader?: ReactNode;
}

export interface MindMapControlsProps {
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  showZoom?: boolean;
  showFit?: boolean;
  showExport?: boolean;
  className?: string;
  onExport?: (type: "png" | "svg" | "json") => void;
}

export type {
  MindElixirData,
  MindElixirInstance,
  MindElixirTheme,
  NodeObj,
  Options,
};
