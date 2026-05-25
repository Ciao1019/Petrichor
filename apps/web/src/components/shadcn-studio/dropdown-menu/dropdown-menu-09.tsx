import * as React from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

export type KbDropdownMenuProps = {
    trigger: React.ReactNode
    children: React.ReactNode
    align?: React.ComponentProps<typeof DropdownMenuContent>['align']
    contentClassName?: string
}

export function KbDropdownMenu({
    trigger,
    children,
    align = 'end',
    contentClassName,
}: KbDropdownMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        asChild
        onClick={(e) => e.stopPropagation()}
      >
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={contentClassName}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default KbDropdownMenu
