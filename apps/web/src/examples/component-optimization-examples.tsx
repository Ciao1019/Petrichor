/**
 * 🎨 React 组件性能优化示例
 */

import { memo, useCallback, useMemo, useRef } from "react"
import { useDebounce, useIntersectionObserver } from "@/hooks/use-performance"

/**
 * 示例 1: 使用 memo 优化列表项
 */
interface ArticleItemProps {
    id: string
    title: string
    excerpt: string
    onClick: (id: string) => void
}

const ArticleItem = memo(({ id, title, excerpt, onClick }: ArticleItemProps) => {
    const handleClick = useCallback(() => {
        onClick(id)
    }, [id, onClick])

    return (
        <div onClick={handleClick} className="cursor-pointer hover:bg-gray-100 p-4 rounded">
            <h3 className="font-semibold">{title}</h3>
            <p className="text-gray-600 text-sm">{excerpt}</p>
        </div>
    )
})

ArticleItem.displayName = "ArticleItem"

/**
 * 示例 2: 搜索输入防抖
 */
export function SearchInput() {
    const [searchTerm, setSearchTerm] = useState("")
    const debouncedSearch = useDebounce(searchTerm, 300)

    // 只在防抖后的值变化时触发搜索
    useEffect(() => {
        if (debouncedSearch) {
            // 执行搜索
            console.log("Searching for:", debouncedSearch)
        }
    }, [debouncedSearch])

    return (
        <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="搜索文章..."
            className="w-full px-4 py-2 border rounded"
        />
    )
}

/**
 * 示例 3: 图片懒加载
 */
export function LazyImage({ src, alt }: { src: string; alt: string }) {
    const imgRef = useRef<HTMLDivElement>(null)
    const isVisible = useIntersectionObserver(imgRef, {
        threshold: 0.1,
        rootMargin: "100px",
    })

    return (
        <div ref={imgRef}>
            <img
                src={isVisible ? src : undefined}
                alt={alt}
                className={`transition-opacity duration-300 ${isVisible ? "opacity-100" : "opacity-0"}`}
            />
        </div>
    )
}

/**
 * 示例 4: 使用 useMemo 优化昂贵计算
 */
type ArticleStatsItem = {
    isPublic: boolean
    wordCount?: number
}

export function ArticleStats({ articles }: { articles: ArticleStatsItem[] }) {
    const stats = useMemo(() => {
        return {
            total: articles.length,
            published: articles.filter((a) => a.isPublic).length,
            draft: articles.filter((a) => !a.isPublic).length,
            totalWords: articles.reduce((sum, a) => sum + (a.wordCount || 0), 0),
        }
    }, [articles])

    return (
        <div className="grid grid-cols-4 gap-4">
            <div>
                <div className="text-2xl font-bold">{stats.total}</div>
                <div className="text-sm text-gray-600">总文章</div>
            </div>
            <div>
                <div className="text-2xl font-bold">{stats.published}</div>
                <div className="text-sm text-gray-600">已发布</div>
            </div>
            <div>
                <div className="text-2xl font-bold">{stats.draft}</div>
                <div className="text-sm text-gray-600">草稿</div>
            </div>
            <div>
                <div className="text-2xl font-bold">{stats.totalWords.toLocaleString()}</div>
                <div className="text-sm text-gray-600">总字数</div>
            </div>
        </div>
    )
}

import { useEffect, useState } from "react"
