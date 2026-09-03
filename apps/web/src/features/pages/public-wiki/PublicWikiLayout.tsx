"use client"

import type * as React from "react"
import { Link } from "react-router-dom"

import {
  RetypesetSiteHeader,
  RetypesetSiteNav,
  type RetypesetSiteActiveSection,
} from "@/features/pages/blog/RetypesetSiteChrome"

export function PublicWikiLayout({
  children,
  wide = false,
  activeSection = "wiki",
}: {
  children: React.ReactNode
  wide?: boolean
  activeSection?: RetypesetSiteActiveSection
}) {
  return (
    <main className="scrollbar-hide retypeset-home relative flex min-h-screen flex-col overflow-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
      <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-10 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection={activeSection} dockVisible />
      </div>
      <section
        className={`relative z-20 mx-auto flex w-full flex-1 flex-col px-[min(7.25vw,3.731rem)] py-12 lg:py-20 ${
          wide
            ? "max-w-[72rem]"
            : "max-w-[51.462rem] lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0"
        }`}
      >
        {children}
      </section>
    </main>
  )
}

export function PublicWikiBreadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>
}) {
  return (
    <nav aria-label="面包屑" className="retypeset-font-navbar mb-6 text-xs opacity-75">
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {item.href ? (
              <Link className="retypeset-highlight-hover" to={item.href}>{item.label}</Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function PublicWikiStatus({
  title,
  detail,
  action,
}: {
  title: string
  detail?: string | null
  action?: React.ReactNode
}) {
  return (
    <div className="border-y border-current/15 py-14 text-center">
      <p className="retypeset-font-navbar font-semibold">{title}</p>
      {detail ? <p className="mx-auto mt-2 max-w-lg text-sm leading-6 opacity-70">{detail}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}

export function resolvePublicWikiError(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg
    || (error instanceof Error ? error.message : "")
    || fallback
  )
}
