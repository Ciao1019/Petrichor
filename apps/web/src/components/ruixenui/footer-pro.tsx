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
        className="retypeset-font-navbar retypeset-c-secondary flex flex-wrap items-center justify-start gap-x-3 gap-y-0.5 text-left text-[0.6875rem] leading-4 lg:flex-col lg:items-start lg:gap-0 lg:text-xs lg:leading-[1.35em]"
      >
        {bottomLinks.map((link) => (
          <a
            key={`${link.label}-${link.href}`}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="retypeset-highlight-hover retypeset-footer-link max-w-full break-words py-[0.15rem] transition-colors focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--retypeset-accent)]"
          >
            {link.label}
          </a>
        ))}
      </nav>
    </footer>
  )
}
