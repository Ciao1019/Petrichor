import * as React from "react"
import type { Components } from "react-markdown"

import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export type MarkdownPreviewVariant = "default" | "heti" | "typography"

type HeadingElement = "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
type HeadingClassMap = Record<HeadingElement, string>
type TableClassMap = {
  table: string
  tr: string
  th: string
  td: string
}

function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const { node, ...rest } = props
  void node
  return rest
}

function renderHeading(
  element: HeadingElement,
  className: string,
  props: React.ComponentProps<HeadingElement> & { node?: unknown }
) {
  const { className: rawClassName, ...rest } = withoutNode(props)
  return React.createElement(element, { ...rest, className: cn(className, rawClassName) })
}

function createHeadingClassMap(variant: MarkdownPreviewVariant): HeadingClassMap {
  if (variant === "typography") {
    return {
      h1: "group text-balance scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl",
      h2: "group mt-10 scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight first:mt-0",
      h3: "group mt-8 scroll-m-20 text-2xl font-semibold tracking-tight",
      h4: "group mt-8 scroll-m-20 text-xl font-semibold tracking-tight",
      h5: "group mt-6 scroll-m-20 text-base font-semibold tracking-tight",
      h6: "group mt-6 scroll-m-20 text-sm font-semibold tracking-tight",
    }
  }

  if (variant === "heti") {
    return {
      h1: "group",
      h2: "group",
      h3: "group",
      h4: "group",
      h5: "group",
      h6: "group",
    }
  }

  return {
    h1: "group scroll-mt-28 mt-3 text-4xl font-semibold tracking-tight md:text-5xl",
    h2: "group scroll-mt-28 mt-12 border-b border-border/60 pb-2 text-2xl font-semibold tracking-tight first:mt-0",
    h3: "group scroll-mt-28 mt-8 text-xl font-semibold tracking-tight",
    h4: "group scroll-mt-28 mt-7 text-lg font-semibold",
    h5: "group scroll-mt-28 mt-6 text-base font-semibold",
    h6: "group scroll-mt-28 mt-6 text-sm font-semibold uppercase tracking-wide",
  }
}

function createHeadingComponents(variant: MarkdownPreviewVariant): Components {
  const map = createHeadingClassMap(variant)
  return {
    h1: (props) => renderHeading("h1", map.h1, props),
    h2: (props) => renderHeading("h2", map.h2, props),
    h3: (props) => renderHeading("h3", map.h3, props),
    h4: (props) => renderHeading("h4", map.h4, props),
    h5: (props) => renderHeading("h5", map.h5, props),
    h6: (props) => renderHeading("h6", map.h6, props),
  }
}

function createAnchorComponent(variant: MarkdownPreviewVariant): NonNullable<Components["a"]> {
  return (props) => {
    const { className, href, ...rest } = withoutNode(props)
    const isHashLink = typeof href === "string" && href.startsWith("#")
    const isHeadingAnchor = typeof className === "string" && className.includes("heading-anchor-link")
    const styleClassName = isHeadingAnchor
      ? "no-underline text-current"
      : variant === "heti"
        ? undefined
        : variant === "typography"
          ? "font-medium text-primary underline underline-offset-4"
          : "font-medium text-primary underline decoration-primary/50 underline-offset-4 transition-colors hover:text-primary/80"

    return (
      <a
        href={href}
        className={cn(styleClassName, className)}
        target={isHashLink || isHeadingAnchor ? undefined : "_blank"}
        rel={isHashLink || isHeadingAnchor ? undefined : "noreferrer"}
        {...rest}
      />
    )
  }
}

function createInputComponent(): NonNullable<Components["input"]> {
  return (props) => {
    const { type, checked, ...rest } = withoutNode(props)
    if (type === "checkbox") {
      return <Checkbox checked={!!checked} disabled className="mr-2 translate-y-[2px]" />
    }
    return <input type={type} {...rest} />
  }
}

function createCodeComponent(inlineClass: string): NonNullable<Components["code"]> {
  return (props) => {
    const inline = (props as { inline?: boolean }).inline
    const { className, children, ...rest } = withoutNode(props)
    if (inline) {
      return (
        <code className={cn(inlineClass, className)} {...rest}>
          {children}
        </code>
      )
    }
    return (
      <code className={cn("font-mono text-sm", className)} {...rest}>
        {children}
      </code>
    )
  }
}

function addTableComponents(components: Components, classes: TableClassMap) {
  components.table = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <Table className={cn(classes.table, className)} {...rest} />
  }
  components.thead = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <TableHeader className={className} {...rest} />
  }
  components.tbody = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <TableBody className={className} {...rest} />
  }
  components.tr = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <TableRow className={cn(classes.tr, className)} {...rest} />
  }
  components.th = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <TableHead className={cn(classes.th, className)} {...rest} />
  }
  components.td = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <TableCell className={cn(classes.td, className)} {...rest} />
  }
}

function applyTypographyComponents(components: Components) {
  components.p = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <p className={cn("leading-7 [&:not(:first-child)]:mt-6", className)} {...rest} />
  }
  components.ul = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <ul className={cn("my-6 ml-6 list-disc [&>li]:mt-2", className)} {...rest} />
  }
  components.ol = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <ol className={cn("my-6 ml-6 list-decimal [&>li]:mt-2", className)} {...rest} />
  }
  components.blockquote = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <blockquote className={cn("mt-6 border-l-2 pl-6 italic", className)} {...rest} />
  }
  components.hr = () => <Separator className="my-6" />
  components.img = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <img className={cn("my-6 max-w-full rounded-xl border", className)} {...rest} />
  }
  components.pre = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <pre className={cn("my-6 overflow-x-auto rounded-xl border bg-muted/50 p-4", className)} {...rest} />
  }
  components.code = createCodeComponent(
    "relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
  )
  addTableComponents(components, {
    table: "my-6 w-full",
    tr: "m-0 border-t p-0 even:bg-muted",
    th: "border px-4 py-2 text-left font-bold [&[align=center]]:text-center [&[align=right]]:text-right",
    td: "border px-4 py-2 text-left [&[align=center]]:text-center [&[align=right]]:text-right",
  })
}

function applyDefaultComponents(components: Components) {
  components.p = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <p className={cn("leading-8 text-foreground/90 [&:not(:first-child)]:mt-5", className)} {...rest} />
  }
  components.ul = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <ul className={cn("my-5 ml-6 list-disc space-y-2", className)} {...rest} />
  }
  components.ol = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <ol className={cn("my-5 ml-6 list-decimal space-y-2", className)} {...rest} />
  }
  components.li = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <li className={cn("leading-7 text-foreground/90", className)} {...rest} />
  }
  components.blockquote = (props) => {
    const { className, ...rest } = withoutNode(props)
    return (
      <blockquote
        className={cn("my-6 rounded-r-lg border-l-2 border-primary/50 bg-primary/5 px-5 py-3 text-foreground/80", className)}
        {...rest}
      />
    )
  }
  components.hr = () => <Separator className="my-6" />
  components.img = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <img className={cn("my-6 max-w-full rounded-xl border shadow-sm", className)} {...rest} />
  }
  components.pre = (props) => {
    const { className, ...rest } = withoutNode(props)
    return <pre className={cn("my-6 overflow-x-auto rounded-xl border bg-muted/70 p-4", className)} {...rest} />
  }
  components.code = createCodeComponent("rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground/95")
  addTableComponents(components, {
    table: "my-6 [&_th]:bg-muted/50 [&_th]:font-semibold",
    tr: "",
    th: "",
    td: "",
  })
}

export function createMarkdownComponents(variant: MarkdownPreviewVariant): Components {
  const components: Components = {
    ...createHeadingComponents(variant),
    a: createAnchorComponent(variant),
    input: createInputComponent(),
  }

  if (variant === "typography") {
    applyTypographyComponents(components)
    return components
  }
  if (variant === "default") {
    applyDefaultComponents(components)
    return components
  }

  return components
}
