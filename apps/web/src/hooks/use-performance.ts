/**
 * 🎨 React 性能优化 Hooks
 */

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * 防抖 Hook
 * @param value 要防抖的值
 * @param delay 延迟时间（毫秒）
 */
export function useDebounce<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState<T>(value)

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value)
        }, delay)

        return () => {
            clearTimeout(handler)
        }
    }, [value, delay])

    return debouncedValue
}

/**
 * 节流 Hook
 * @param callback 要节流的回调函数
 * @param delay 延迟时间（毫秒）
 */
export function useThrottle<T extends (...args: any[]) => any>(
    callback: T,
    delay: number
): T {
    const lastRun = useRef(Date.now())

    return useCallback(
        (...args: Parameters<T>) => {
            const now = Date.now()
            if (now - lastRun.current >= delay) {
                callback(...args)
                lastRun.current = now
            }
        },
        [callback, delay]
    ) as T
}

/**
 * 交叉观察器 Hook（用于懒加载）
 * @param ref 要观察的元素引用
 * @param options IntersectionObserver 选项
 */
export function useIntersectionObserver(
    ref: React.RefObject<Element>,
    options?: IntersectionObserverInit
): boolean {
    const [isIntersecting, setIsIntersecting] = useState(false)

    useEffect(() => {
        const element = ref.current
        if (!element) return

        const observer = new IntersectionObserver(([entry]) => {
            setIsIntersecting(entry.isIntersecting)
        }, options)

        observer.observe(element)

        return () => {
            observer.disconnect()
        }
    }, [ref, options])

    return isIntersecting
}

/**
 * 虚拟化列表 Hook（简化版）
 * @param itemCount 总项目数
 * @param itemHeight 每项高度
 * @param containerHeight 容器高度
 */
export function useVirtualList(
    itemCount: number,
    itemHeight: number,
    containerHeight: number
) {
    const [scrollTop, setScrollTop] = useState(0)

    const startIndex = Math.floor(scrollTop / itemHeight)
    const endIndex = Math.min(
        itemCount - 1,
        Math.ceil((scrollTop + containerHeight) / itemHeight)
    )

    const visibleItems = Array.from(
        { length: endIndex - startIndex + 1 },
        (_, i) => startIndex + i
    )

    const totalHeight = itemCount * itemHeight

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop)
    }, [])

    return {
        visibleItems,
        totalHeight,
        startIndex,
        handleScroll,
        offsetY: startIndex * itemHeight,
    }
}

/**
 * 媒体查询 Hook
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(false)

    useEffect(() => {
        const media = window.matchMedia(query)
        if (media.matches !== matches) {
            setMatches(media.matches)
        }

        const listener = () => setMatches(media.matches)
        media.addEventListener("change", listener)

        return () => media.removeEventListener("change", listener)
    }, [matches, query])

    return matches
}

/**
 * 延迟加载 Hook
 * 在指定延迟后才渲染子组件
 */
export function useDeferredRender(delay: number = 100): boolean {
    const [shouldRender, setShouldRender] = useState(false)

    useEffect(() => {
        const timer = setTimeout(() => {
            setShouldRender(true)
        }, delay)

        return () => clearTimeout(timer)
    }, [delay])

    return shouldRender
}
