import gsap from "gsap"

// 全局动画默认值：统一节奏 & 缓动，避免每处单独配置。
// 通过 power 系列贝塞尔（≈ 60Hz 优化的 RAF 驱动）替代 CSS transition。
gsap.defaults({
  ease: "power3.out",
  duration: 0.22,
  overwrite: "auto",
})

// 全局 ticker 提示：让 GSAP 跟随浏览器 RAF，省一次 setTimeout 调度
gsap.ticker.lagSmoothing(500, 33)

export { gsap }

export type EaseId =
  | "fast"
  | "smooth"
  | "spring"
  | "linear"
  | "bounce"

export const EASE: Record<EaseId, string> = {
  fast: "power2.out",
  smooth: "power3.out",
  spring: "elastic.out(1, 0.6)",
  linear: "none",
  bounce: "back.out(1.4)",
}

export const DURATION = {
  xs: 0.12,
  sm: 0.18,
  md: 0.24,
  lg: 0.32,
  xl: 0.45,
}

/** 立即把元素隐藏（不参与初始绘制），便于入场动画。 */
export function gsapInitialHidden(el: Element | null) {
  if (!el) return
  gsap.set(el, { autoAlpha: 0 })
}
