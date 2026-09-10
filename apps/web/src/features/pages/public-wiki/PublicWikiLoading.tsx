import { ArticleLoadingSkeleton } from "@/components/article-loading-skeleton"

export function PublicWikiLoading() {
  return <ArticleLoadingSkeleton className="px-0 py-8 lg:px-0" showToolbar={false} label="Wiki 页面加载中" />
}
