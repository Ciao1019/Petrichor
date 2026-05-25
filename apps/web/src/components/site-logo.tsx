import type { ImgHTMLAttributes } from "react"

import { cn } from "@/lib/utils"

const SITE_LOGO_SRC = "/sidebar-logo.jpg"

type SiteLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "width" | "height"> & {
  size?: number
}

export function SiteLogo({
  alt = "Petrichor",
  className,
  size = 24,
  ...props
}: SiteLogoProps) {
  return (
    <img
      src={SITE_LOGO_SRC}
      alt={alt}
      width={size}
      height={size}
      className={cn("shrink-0 rounded-full object-cover", className)}
      {...props}
    />
  )
}
