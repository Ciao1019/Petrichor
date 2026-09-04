// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/blog-search-dialog", () => ({
    BlogSearchDialog: () => null,
    useBlogSearchHotkey: () => undefined,
}))

vi.mock("@/components/iconimate", () => ({
    Github: () => <svg aria-hidden="true" />,
    MessageCircleQuestion: () => <svg aria-hidden="true" />,
    Search: () => <svg aria-hidden="true" />,
}))

vi.mock("@/components/public-site-footer", () => ({
    PublicSiteFooter: ({ className }: { className?: string }) => (
        <footer className={className} data-public-filing-footer>
            备案信息
        </footer>
    ),
}))

vi.mock("@/lib/demo/demo-mode", () => ({
    isDemoOnlyBuild: () => false,
}))

import { RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"

afterEach(cleanup)

describe("RetypesetSiteNav", () => {
    it("将备案信息放在首屏导航整体内", () => {
        const { container } = render(
            <MemoryRouter>
                <RetypesetSiteNav activeSection="articles" dockVisible />
            </MemoryRouter>,
        )

        const navigation = screen.getByRole("navigation", { name: "站点导航" })
        const filing = container.querySelector<HTMLElement>("[data-public-filing-footer]")
        const navigationGroup = container.querySelector<HTMLElement>("[data-public-site-navigation]")

        expect(navigationGroup?.contains(navigation)).toBe(true)
        expect(navigationGroup?.contains(filing)).toBe(true)
        expect(filing?.classList.contains("lg:fixed")).toBe(true)
        expect(filing?.classList.contains("lg:bottom-20")).toBe(true)
        expect(filing?.classList.contains("fixed")).toBe(false)
    })
})
