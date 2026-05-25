import * as React from 'react'

import { cn } from '@/lib/utils'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type KbDialogProps = {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    description?: string
    children?: React.ReactNode
    footer?: React.ReactNode
    contentClassName?: string
    disableClose?: boolean
}

export function KbDialog({
    open,
    onOpenChange,
    title,
    description,
    children,
    footer,
    contentClassName,
    disableClose = false,
}: KbDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (disableClose && !nextOpen) {
          return
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent
        className={cn(
          "sm:max-w-lg flex max-h-[calc(100vh-2rem)] flex-col",
          contentClassName
        )}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className='text-xl'>{title}</DialogTitle>
          {description ? (
            <DialogDescription className='text-base'>
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>

        {footer ? <DialogFooter className="shrink-0">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  )
}

export default KbDialog
