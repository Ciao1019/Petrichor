import { Loader2, MessageSquarePlus, PanelLeftOpen } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function AssistantChatToolbar({
  sidebarOpen,
  loading,
  onOpenSidebar,
  onNewThread,
}: {
  sidebarOpen: boolean
  loading: boolean
  onOpenSidebar: () => void
  onNewThread: () => void
}) {
  return (
    <header aria-label="对话操作" className="flex h-12 shrink-0 items-center gap-3 px-3 md:px-4">
      <div className="flex shrink-0 items-center gap-1">
        {!sidebarOpen ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 rounded-lg text-muted-foreground hover:text-foreground"
                aria-label="展开对话列表"
                onClick={onOpenSidebar}
              >
                <PanelLeftOpen className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">展开对话列表</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-9 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label="新建对话"
              onClick={onNewThread}
            >
              <MessageSquarePlus className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新建对话</TooltipContent>
        </Tooltip>
      </div>
      {loading ? (
        <span role="status" className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span className="sr-only sm:not-sr-only">加载中</span>
        </span>
      ) : null}
    </header>
  )
}
