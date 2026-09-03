"use client"

import { cn } from "@/lib/utils"

export interface FooterProLink {
  label: string
  href: string
}

export interface FooterProProps {
  bottomLinks?: FooterProLink[]
  className?: string
}

export default function FooterPro({ bottomLinks = [], className }: FooterProProps) {
  if (bottomLinks.length === 0) return null

  return (
    <footer
      className={cn("retypeset-home relative z-20 w-full", className)}
      data-public-filing-footer
    >
      <nav
        aria-label="备案信息"
        className="retypeset-c-secondary mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-5 gap-y-2 px-6 py-6 text-center text-xs sm:px-8 sm:py-8"
      >
        {bottomLinks.map((link) => (
          <a
            key={`${link.label}-${link.href}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-4 opacity-80 transition-opacity hover:opacity-100 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--retypeset-accent)]"
          >
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  )
}
