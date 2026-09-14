"use client"

import type * as React from "react"
import { useLayoutEffect } from "react"
import { Link, useLocation } from "react-router-dom"

import {
  RetypesetSiteFooter,
  RetypesetSiteHeader,
  RetypesetSiteNav,
  type RetypesetSiteActiveSection,
} from "@/features/pages/blog/RetypesetSiteChrome"

import { ChevronRight } from "@/components/iconimate"

export function PublicWikiLayout({
  children,
  wide = false,
  activeSection = "wiki",
}: {
  children: React.ReactNode
  wide?: boolean
  activeSection?: RetypesetSiteActiveSection
}) {
  const { pathname } = useLocation()
  useLayoutEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return (
    <main className="scrollbar-hide retypeset-home public-wiki relative flex min-h-screen flex-col overflow-x-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />
      <div className="relative z-30 mx-auto w-full max-w-[54rem] px-[min(7.25vw,3.731rem)] pt-10 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection={activeSection} dockVisible />
      </div>
      <section
        className={`relative z-20 mx-auto flex w-full flex-1 flex-col px-[min(7.25vw,3.731rem)] py-8 lg:py-16 ${
          wide
            ? "max-w-[72rem]"
            : "max-w-[54rem] lg:mx-[max(5.75rem,calc(50vw-35rem))] lg:max-w-[min(calc(75vw-16rem),48rem)] lg:px-0"
        }`}
      >
        {children}
      </section>
      <RetypesetSiteFooter />
    </main>
  )
}

export function PublicWikiBreadcrumbs({
  items,
}: {
  items: Array<{ label: string; href?: string }>
}) {
  return (
    <nav aria-label="面包屑" className="mb-6 text-xs">
      <ol className="flex flex-wrap items-center gap-1.5 text-white/60">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1.5">
            {index > 0 ? (
              <ChevronRight className="size-3 text-white/30" aria-hidden="true" />
            ) : null}
            {item.href ? (
              <Link
                className="transition-colors hover:text-white"
                to={item.href}
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="font-medium text-white/90">
                {item.label}
              </span>
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
  icon,
}: {
  title: string
  detail?: string | null
  action?: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <div className="my-6 flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-14 text-center backdrop-blur-xs">
      {icon ? (
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-white/80 shadow-inner">
          {icon}
        </div>
      ) : null}
      <p className="retypeset-font-navbar text-base font-semibold text-white/90">{title}</p>
      {detail ? (
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-white/60">{detail}</p>
      ) : null}
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
