"use client"

import * as React from "react"
import { IconChevronRight } from "@/components/iconimate"
import { Link, useLocation } from "react-router-dom"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { GsapCollapse } from "@/components/ui/gsap-collapse"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

type NavIcon = React.ComponentType<{ className?: string }>

export function NavContent({
  groupLabel,
  items,
  collapsibleGroup = false,
  defaultGroupOpen,
}: {
  groupLabel: string
  items: {
    title: string
    url: string
    icon: NavIcon
    isActive?: boolean
    match?: (pathname: string) => boolean
    items?: {
      title: string
      url: string
      icon?: NavIcon
      match?: (pathname: string) => boolean
    }[]
  }[]
  /** 整组可折叠：用于降低非主线入口的视觉权重 */
  collapsibleGroup?: boolean
  /** 组默认展开；未传时：有激活项则展开，否则折叠 */
  defaultGroupOpen?: boolean
}) {
  const location = useLocation()
  const { isMobile, setOpenMobile, state } = useSidebar()
  const closeMobileMenu = () => { if (isMobile) setOpenMobile(false) }
  const matchNavItem = (item: {
    url: string
    match?: (pathname: string) => boolean
  }) => {
    if (item.match) {
      return item.match(location.pathname)
    }
    return (
      location.pathname === item.url ||
      location.pathname.startsWith(`${item.url}/`)
    )
  }

  const hasActiveItem = items.some(
    (item) =>
      item.isActive ||
      matchNavItem(item) ||
      item.items?.some((sub) => matchNavItem(sub)),
  )
  const [groupOpen, setGroupOpen] = React.useState(
    defaultGroupOpen ?? hasActiveItem,
  )

  React.useEffect(() => {
    if (hasActiveItem) {
      setGroupOpen(true)
    }
  }, [hasActiveItem, location.pathname])

  // 图标模式没有分组标题，保持入口可达；展开侧栏后恢复用户的折叠选择。
  const open = groupOpen || (!isMobile && state === "collapsed")

  const menu = (
    <SidebarMenu>
      {items.map((item) => {
        const hasChildren = Boolean(item.items && item.items.length > 0)

        if (!hasChildren) {
          const isActive = matchNavItem(item)
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                <Link to={item.url} aria-current={isActive ? "page" : undefined} onClick={closeMobileMenu}>
                  <item.icon />
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        }

        return (
          <NavCollapsibleItem
            key={item.title}
            item={item}
            matchNavItem={matchNavItem}
            onNavigate={closeMobileMenu}
          />
        )
      })}
    </SidebarMenu>
  )

  if (!collapsibleGroup) {
    return (
      <SidebarGroup>
        <SidebarGroupLabel>{groupLabel}</SidebarGroupLabel>
        <nav aria-label={groupLabel}>{menu}</nav>
      </SidebarGroup>
    )
  }

  return (
    <SidebarGroup>
      <Collapsible open={open} onOpenChange={setGroupOpen} className="group/nav-group">
        <CollapsibleTrigger asChild>
          <SidebarGroupLabel
            asChild
            className={cn(
              "cursor-pointer select-none hover:text-sidebar-foreground",
              "flex w-full items-center justify-between pr-1 group-data-[collapsible=icon]:hidden",
            )}
          >
            <button type="button">
              <span>{groupLabel}</span>
              <IconChevronRight
                className={cn(
                  "size-3.5 opacity-50 transition-transform duration-200 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
            </button>
          </SidebarGroupLabel>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount inert={!open} aria-hidden={!open}>
          <GsapCollapse open={open}><nav aria-label={groupLabel}>{menu}</nav></GsapCollapse>
        </CollapsibleContent>
      </Collapsible>
    </SidebarGroup>
  )
}

function NavCollapsibleItem({
  item,
  matchNavItem,
  onNavigate,
}: {
  item: {
    title: string
    url: string
    icon: NavIcon
    isActive?: boolean
    items?: { title: string; url: string; icon?: NavIcon; match?: (pathname: string) => boolean }[]
  }
  matchNavItem: (item: { url: string; match?: (pathname: string) => boolean }) => boolean
  onNavigate: () => void
}) {
  const [open, setOpen] = React.useState(Boolean(item.isActive))

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.title} isActive={item.isActive}>
            <item.icon />
            <span>{item.title}</span>
            <IconChevronRight className="ml-auto transition-transform duration-200 motion-reduce:transition-none group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent forceMount inert={!open} aria-hidden={!open}>
          <GsapCollapse open={open}>
            <SidebarMenuSub>
              {item.items?.map((subItem) => {
                const isActive = matchNavItem(subItem)
                return (
                  <SidebarMenuSubItem key={subItem.title}>
                    <SidebarMenuSubButton asChild isActive={isActive}>
                      <Link to={subItem.url} aria-current={isActive ? "page" : undefined} onClick={onNavigate}>
                        {subItem.icon && <subItem.icon />}
                        <span>{subItem.title}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )
              })}
            </SidebarMenuSub>
          </GsapCollapse>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  )
}
