import * as React from "react"
import { gsap } from "@/lib/gsap"

/**
 * 在 React 中安全绑定 GSAP context，所有 selector / tweens 在卸载或 deps 变化时自动 revert。
 * 用法：
 *   const ref = useGsapContext<HTMLDivElement>((ctx, root) => {
 *     gsap.fromTo(root.querySelectorAll(".item"), { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, stagger: 0.04 })
 *   }, [deps])
 */
export function useGsapContext<T extends HTMLElement>(
  setup: (ctx: gsap.Context, root: T) => void,
  deps: React.DependencyList = [],
) {
  const ref = React.useRef<T | null>(null)

  React.useLayoutEffect(() => {
    if (!ref.current) return
    const root = ref.current
    const ctx = gsap.context((self) => setup(self, root), root)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return ref
}

/**
 * 在某个布尔状态切换时执行进入 / 退出动画（替代 transition-[width|height|opacity]）。
 * 不需要测量目标高度时建议直接传 `to` / `from`。
 */
export function useGsapToggle<T extends HTMLElement>(
  open: boolean,
  build: (open: boolean, root: T) => gsap.TweenVars,
  options?: { duration?: number; ease?: string; skipMount?: boolean },
) {
  const ref = React.useRef<T | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!mountedRef.current && options?.skipMount !== false) {
      mountedRef.current = true
      return
    }
    const vars = build(open, el)
    const tween = gsap.to(el, {
      duration: options?.duration ?? 0.22,
      ease: options?.ease ?? "power3.out",
      ...vars,
    })
    return () => {
      tween.kill()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return ref
}
