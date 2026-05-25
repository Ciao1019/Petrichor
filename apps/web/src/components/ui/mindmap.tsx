"use client";

import "mind-elixir/style.css";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Minus, Plus, Download, Loader2, Maximize, ScanSearch } from "lucide-react";

import { cn } from "@/lib/utils";
import { snapdom } from "@zumer/snapdom";
import type {
  MindMapContextValue,
  MindMapControlsProps,
  MindMapProps,
  MindMapRef,
  MindElixirInstance,
  MindElixirTheme,
  Options,
} from "./mindmap-types";

// 根据 document class 解析主题（适配 next-themes 等方案）
function getDocumentTheme(): Theme | null {
  if (typeof document === "undefined") return null;
  if (document.documentElement.classList.contains("dark")) return "dark";
  if (document.documentElement.classList.contains("light")) return "light";
  return null;
}

// 获取系统主题偏好
function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useResolvedTheme(themeProp?: "light" | "dark"): "light" | "dark" {
  const [detectedTheme, setDetectedTheme] = useState<"light" | "dark">(
    () => getDocumentTheme() ?? getSystemTheme(),
  );

  useEffect(() => {
    if (themeProp) return; // Skip detection if theme is provided via prop

    // 监听 document class 变化（例如 next-themes 切换 dark class）
    const observer = new MutationObserver(() => {
      const docTheme = getDocumentTheme();
      if (docTheme) {
        setDetectedTheme(docTheme);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    // 同时监听系统主题变化
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = (e: MediaQueryListEvent) => {
      // 仅在 document 未显式设置主题 class 时使用系统偏好
      if (!getDocumentTheme()) {
        setDetectedTheme(e.matches ? "dark" : "light");
      }
    };
    mediaQuery.addEventListener("change", handleSystemChange);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener("change", handleSystemChange);
    };
  }, [themeProp]);

  return themeProp ?? detectedTheme;
}

type Theme = "light" | "dark";

const MindMapContext = createContext<MindMapContextValue | null>(null);

export function useMindMap() {
  const context = useContext(MindMapContext);
  if (!context) {
    throw new Error("useMindMap must be used within a MindMap component");
  }
  return context;
}

function DefaultLoader() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

// 常用间距与布局配置
const commonSpacing = {
  "--node-gap-x": "48px",
  "--node-gap-y": "16px",
  "--main-gap-x": "24px",
  "--main-gap-y": "32px",
  "--root-radius": "0.625rem",
  "--main-radius": "0.5rem",
  "--topic-padding": "8px 16px",
  "--map-padding": "48px",
};

// 创建主题的辅助方法
function createTheme(
  name: string,
  type: "light" | "dark",
  colors: {
    mainColor: string;
    mainBgcolor: string;
    color: string;
    bgcolor: string;
    selected: string;
    accentColor: string;
    rootColor: string;
    rootBgcolor: string;
    rootBorderColor: string;
    panelColor: string;
    panelBgcolor: string;
    panelBorderColor: string;
  },
  palette: string[]
): MindElixirTheme {
  return {
    name,
    type,
    palette,
    cssVar: {
      ...commonSpacing,
      "--main-color": colors.mainColor,
      "--main-bgcolor": colors.mainBgcolor,
      "--main-bgcolor-transparent": `${colors.mainBgcolor.replace(")", " / 95%)")}`,
      "--color": colors.color,
      "--bgcolor": colors.bgcolor,
      "--selected": colors.selected,
      "--accent-color": colors.accentColor,
      "--root-color": colors.rootColor,
      "--root-bgcolor": colors.rootBgcolor,
      "--root-border-color": colors.rootBorderColor,
      "--panel-color": colors.panelColor,
      "--panel-bgcolor": colors.panelBgcolor,
      "--panel-border-color": colors.panelBorderColor,
    },
  };
}

// 基础颜色配置
const lightColors = {
  mainColor: "oklch(0.145 0 0)",           // foreground
  mainBgcolor: "oklch(1 0 0)",             // background (white)
  color: "oklch(0.145 0 0)",               // foreground
  bgcolor: "oklch(1 0 0)",                 // card background
  selected: "oklch(0.205 0 0)",            // primary
  rootColor: "oklch(0.985 0 0)",           // primary-foreground
  rootBgcolor: "oklch(0.205 0 0)",         // primary
  rootBorderColor: "oklch(0.205 0 0)",     // primary
  panelColor: "oklch(0.145 0 0)",          // foreground
  panelBgcolor: "oklch(1 0 0)",            // popover
  panelBorderColor: "oklch(0.922 0 0)",    // border
};

const darkColors = {
  mainColor: "oklch(0.985 0 0)",           // foreground
  mainBgcolor: "oklch(0.145 0 0)",         // background (dark)
  color: "oklch(0.985 0 0)",               // foreground
  bgcolor: "oklch(0.205 0 0)",             // card background
  selected: "oklch(0.922 0 0)",            // primary
  rootColor: "oklch(0.205 0 0)",           // primary-foreground
  rootBgcolor: "oklch(0.922 0 0)",         // primary
  rootBorderColor: "oklch(0.922 0 0)",     // primary
  panelColor: "oklch(0.985 0 0)",          // foreground
  panelBgcolor: "oklch(0.205 0 0)",        // popover
  panelBorderColor: "oklch(1 0 0 / 10%)",  // border
};

// shadcn 风格：亮色主题
const lightTheme: MindElixirTheme = createTheme(
  "shadcn-light",
  "light",
  {
    ...lightColors,
    accentColor: "oklch(0.646 0.222 41.116)", // chart-1 (vibrant)
  },
  [
    "oklch(0.646 0.222 41.116)", // chart-1: vibrant orange
    "oklch(0.6 0.118 184.704)",   // chart-2: teal
    "oklch(0.398 0.07 227.392)",  // chart-3: blue
    "oklch(0.828 0.189 84.429)",  // chart-4: yellow-green
    "oklch(0.769 0.188 70.08)",   // chart-5: warm yellow
    "oklch(0.488 0.243 264.376)", // purple
    "oklch(0.696 0.17 162.48)",   // mint
  ]
);

// shadcn 风格：暗色主题
const darkTheme: MindElixirTheme = createTheme(
  "shadcn-dark",
  "dark",
  {
    ...darkColors,
    accentColor: "oklch(0.488 0.243 264.376)", // chart-1 (purple)
  },
  [
    "oklch(0.488 0.243 264.376)", // chart-1: purple
    "oklch(0.696 0.17 162.48)",   // chart-2: mint
    "oklch(0.769 0.188 70.08)",   // chart-3: warm yellow
    "oklch(0.627 0.265 303.9)",   // chart-4: pink
    "oklch(0.645 0.246 16.439)",  // chart-5: coral
    "oklch(0.646 0.222 41.116)",  // orange
    "oklch(0.6 0.118 184.704)",   // teal
  ]
);

// 单色模式：复用基础色，仅替换 accentColor 与 palette
const lightThemeMonochrome: MindElixirTheme = createTheme(
  "shadcn-light-mono",
  "light",
  {
    ...lightColors,
    accentColor: "oklch(0.205 0 0)", // primary
  },
  ["oklch(0.205 0 0)"] // Single primary color
);

const darkThemeMonochrome: MindElixirTheme = createTheme(
  "shadcn-dark-mono",
  "dark",
  {
    ...darkColors,
    accentColor: "oklch(0.922 0 0)", // primary
  },
  ["oklch(0.922 0 0)"] // Single primary color
)

// 根据主题/单色模式选择对应主题
function getTheme(isDark: boolean, isMonochrome: boolean): MindElixirTheme {
  if (isDark) {
    return isMonochrome ? darkThemeMonochrome : darkTheme;
  }
  return isMonochrome ? lightThemeMonochrome : lightTheme;
}

const SIDE = 2;
export const MindMap = forwardRef<MindMapRef, MindMapProps>(function MindMap({
  children,
  data,
  className,
  direction = SIDE,
  contextMenu = true,
  nodeMenu = true,
  keypress = true,
  locale = "en",
  overflowHidden = false,
  mainLinkStyle = 2,
  theme: themeProp,
  monochrome = false,
  fit = true,
  readonly = false,
  onChange,
  onOperation,
  onSelectNodes,
  loader,
}: MindMapProps, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindRef = useRef<MindElixirInstance | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [mindInstance, setMindInstance] = useState<MindElixirInstance | null>(
    null,
  );
  const [isMounted, setIsMounted] = useState(false);
  const resolvedTheme = useResolvedTheme(themeProp);
  const id = useId();

  // 通过 ref 向父组件暴露 mind 实例
  useImperativeHandle(ref, () => ({
    instance: mindRef.current,
  }), []);

  // 使用 ref 保存 resolvedTheme，避免触发不必要的 effect 重跑
  const resolvedThemeRef = useRef(resolvedTheme);
  useEffect(() => {
    resolvedThemeRef.current = resolvedTheme;
  }, [resolvedTheme]);

  // 将回调存入 ref，避免回调变化导致重新初始化
  const onChangeRef = useRef(onChange);
  const onOperationRef = useRef(onOperation);
  const onSelectNodesRef = useRef(onSelectNodes);

  useEffect(() => {
    onChangeRef.current = onChange;
    onOperationRef.current = onOperation;
    onSelectNodesRef.current = onSelectNodes;
  }, [onChange, onOperation, onSelectNodes]);

  // 初始数据仅用于初始化（非响应式）
  const initialDataRef = useRef(data);

  // 确保仅在客户端渲染（避免 SSR 场景问题）
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // 初始化 MindElixir（仅客户端）
  useEffect(() => {
    if (!isMounted || !containerRef.current || mindRef.current) return;

    let isSubscribed = true;

    // 动态 import：避免 SSR/打包场景下的 DOM 依赖问题
    import("mind-elixir").then((MindElixirModule) => {
      if (!isSubscribed || !containerRef.current) return;

      const MindElixir = MindElixirModule.default;

      const options = {
        el: containerRef.current,
        direction,
        contextMenu,
        toolBar: false,
        nodeMenu,
        keypress,
        locale,
        overflowHidden,
        mainLinkStyle,
        editable: !readonly,
        alignment: "nodes",
        theme:
          getTheme(resolvedThemeRef.current === "dark", monochrome),
      } as Options;

      try {
        const mind = new MindElixir(options);

        // 使用初始数据初始化（不跟随 data prop 变化自动重建）
        const initialData = initialDataRef.current || MindElixir.new("Mind Map");
        mind.init(initialData);

        if (isSubscribed) {
          mindRef.current = mind;
          setMindInstance(mind);
          setIsLoaded(true);

          // 可选：初始化后自动缩放适配
          if (fit) {
            mind.scaleFit();
          }

          // 事件监听（使用 ref 保存回调，避免重建）
          mind.bus.addListener("operation", (operation) => {
            console.log(operation);

            // onOperation 回调
            if (onOperationRef.current) {
              onOperationRef.current(operation);
            }
            // onChange 回调
            if (onChangeRef.current) {
              const updatedData = mind.getData();
              // 标记为内部变更，避免外部 refresh 造成循环
              isInternalChangeRef.current = true;
              onChangeRef.current(updatedData, operation);
            }
          });

          if (onSelectNodesRef.current) {
            mind.bus.addListener("selectNodes", (nodeObj) => {
              onSelectNodesRef.current?.(nodeObj);
            });
          }
        }
      } catch (error) {
        console.error("Failed to initialize MindElixir:", error);
      }
    });

    return () => {
      isSubscribed = false;
      // 说明：这里不主动销毁 mind 实例，避免与 React 的 DOM 生命周期冲突
      // 实例会随组件卸载自然释放
      mindRef.current = null;
    };
  }, [
    isMounted,
    direction,
    contextMenu,
    nodeMenu,
    keypress,
    locale,
    overflowHidden,
    mainLinkStyle,
    monochrome,
    readonly,
    fit,
  ]);

  // 跟踪内部变更，避免 refresh 循环
  const isInternalChangeRef = useRef(false);

  // data 变化时刷新（外部驱动）
  useEffect(() => {
    if (mindRef.current && data && isLoaded) {
      // 如果本次变更来自 onChange（内部变更），跳过 refresh，避免循环
      if (isInternalChangeRef.current) {
        isInternalChangeRef.current = false;
        return;
      }
      mindRef.current.refresh(data);
    }
  }, [data, isLoaded]);

  // 布局方向变化时重排（避免只在初始化时生效）
  useEffect(() => {
    if (!mindRef.current || !isLoaded) return;

    if (direction === 0) {
      mindRef.current.initLeft();
      return;
    }
    if (direction === 1) {
      mindRef.current.initRight();
      return;
    }
    mindRef.current.initSide();
  }, [direction, isLoaded]);

  // 主题变化时切换 MindElixir 主题
  useEffect(() => {
    if (!mindRef.current || !isLoaded) return;

    const newTheme = getTheme(resolvedTheme === "dark", monochrome);
    mindRef.current.changeTheme(newTheme);
  }, [resolvedTheme, monochrome, isLoaded]);

  return (
    <MindMapContext.Provider value={{ mind: mindInstance, isLoaded }}>
      <div className={cn("relative w-full h-full", className)}>
        <div
          key={id}
          ref={containerRef}
          id={`mindmap-${id}`}
          className="w-full h-full bg-background rounded-lg overflow-hidden"
        />
        {!isMounted || !isLoaded ? loader || <DefaultLoader /> : null}
        {children}
      </div>
    </MindMapContext.Provider>
  );
});

// MindMap 控制栏
export function MindMapControls({
  position = "top-right",
  showZoom = true,
  showFit = true,
  showExport = true,
  className,
  onExport,
}: MindMapControlsProps) {
  const { mind, isLoaded } = useMindMap();
  const [mounted, setMounted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(timer);
  }, []);

  const handleZoomIn = () => {
    if (mind) {
      const currentScale = mind.scaleVal || 1;
      mind.scale(currentScale + 0.2);
    }
  };

  const handleZoomOut = () => {
    if (mind) {
      const currentScale = mind.scaleVal || 1;
      mind.scale(Math.max(0.2, currentScale - 0.2));
    }
  };

  const handleFit = () => {
    if (mind) {
      mind.scaleFit();
    }
  };

  const handleExport = async () => {
    if (mind) {
      try {
        // 使用 snapdom 导出图片
        const result = await snapdom(mind.nodes);
        await result.download({ type: "jpg", filename: "mindmap" });

        if (onExport) {
          onExport("png");
        }
      } catch (error) {
        console.error("Failed to export mind map:", error);
      }
    }
  };

  const handleFullscreen = () => {
    const container = mind?.container?.parentElement;
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      });
    }
  };

  // 监听全屏状态变化
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!document.fullscreenElement;
      setIsFullscreen(isNowFullscreen);

      // 退出全屏后自动 fit，确保内容可见
      if (!isNowFullscreen && mind) {
        mind.scaleFit();
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [mind]);

  if (!mounted || !isLoaded) return null;

  const positionClasses = {
    "top-left": "top-3 left-3",
    "top-right": "top-3 right-3",
    "bottom-left": "bottom-3 left-3",
    "bottom-right": "bottom-3 right-3",
  };

  return (
    <div
      className={cn(
        "absolute z-10 flex flex-col gap-1",
        positionClasses[position],
        className,
      )}
    >
      {showZoom && (
        <>
          <button
            onClick={handleZoomIn}
            className="size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"
            aria-label="Zoom in"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={handleZoomOut}
            className="size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"
            aria-label="Zoom out"
          >
            <Minus className="size-4" />
          </button>
        </>
      )}
      {showFit && (
        <button
          onClick={handleFit}
          className="size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"
          aria-label="Fit to screen"
        >
          <ScanSearch className="size-4" />
        </button>
      )}
      <button
        onClick={handleFullscreen}
        className="size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      >
        <Maximize className="size-4" />
      </button>
      {showExport && (
        <button
          onClick={handleExport}
          className="size-8 rounded-md bg-background/95 backdrop-blur-md border border-border/50 shadow-lg flex items-center justify-center hover:bg-accent transition-colors"
          aria-label="Download as image"
        >
          <Download className="size-4" />
        </button>
      )}
    </div>
  );
}

// 导出组件
