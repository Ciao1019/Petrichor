"use client"

import * as React from "react"
import { IconChevronRight, type Icon } from "@tabler/icons-react"
import { Link, useLocation } from "react-router-dom"
import {
  Collapsible,
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
} from "@/components/ui/sidebar"

export function NavContent({
  groupLabel,
  items,
}: {
  groupLabel: string
  items: {
    title: string
    url: string
    icon: Icon
    isActive?: boolean
    match?: (pathname: string) => boolean
    items?: {
      title: string
      url: string
      icon?: Icon
      match?: (pathname: string) => boolean
    }[]
  }[]
}) {
  const location = useLocation()
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

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{groupLabel}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const hasChildren = Boolean(item.items && item.items.length > 0)

          if (!hasChildren) {
            const isActive = matchNavItem(item)
            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
                  <Link to={item.url}>
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
            />
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function NavCollapsibleItem({
  item,
  matchNavItem,
}: {
  item: {
    title: string
    url: string
    icon: Icon
    isActive?: boolean
    items?: { title: string; url: string; icon?: Icon; match?: (pathname: string) => boolean }[]
  }
  matchNavItem: (item: { url: string; match?: (pathname: string) => boolean }) => boolean
}) {
  // Radix 控制状态、GSAP 接管视觉过渡。
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
            <IconChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <GsapCollapse open={open}>
          <SidebarMenuSub>
            {item.items?.map((subItem) => {
              const isActive = matchNavItem(subItem)
              return (
                <SidebarMenuSubItem key={subItem.title}>
                  <SidebarMenuSubButton asChild isActive={isActive}>
                    <Link to={subItem.url}>
                      {subItem.icon && <subItem.icon />}
                      <span>{subItem.title}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })}
          </SidebarMenuSub>
        </GsapCollapse>
      </SidebarMenuItem>
    </Collapsible>
  )
}
