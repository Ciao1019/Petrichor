// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider, useTheme } from './theme-provider'
import { ThemeToggle } from './theme-toggle'

function ThemeStatus() {
  const { theme, resolvedTheme } = useTheme()
  return <output>{theme}:{resolvedTheme}</output>
}

function renderTheme() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
      <ThemeStatus />
    </ThemeProvider>,
  )
}

let darkMedia: EventTarget & { matches: boolean }
let reducedMotion: boolean

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.className = ''
  document.documentElement.style.colorScheme = ''
  darkMedia = Object.assign(new EventTarget(), { matches: true })
  reducedMotion = false
  vi.stubGlobal('matchMedia', vi.fn((query: string) => (
    query === '(prefers-color-scheme: dark)'
      ? darkMedia
      : { matches: reducedMotion }
  )))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'startViewTransition')
})

describe('共享昼夜主题', () => {
  it('系统深色时显示月亮，切换后持久化并在重新进入时恢复', () => {
    const first = renderTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('system:dark')

    fireEvent.click(screen.getByRole('button', { name: '切换到浅色模式' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(window.localStorage.getItem('ui-theme')).toBe('light')

    first.unmount()
    renderTheme()
    expect(screen.getByRole('status').textContent).toBe('light:light')
    expect(screen.getByRole('button', { name: '切换到深色模式' })).toBeDefined()
  })

  it('尚未手动选择时跟随系统变化，同时更新根样式和按钮状态', () => {
    renderTheme()
    act(() => {
      darkMedia.matches = false
      darkMedia.dispatchEvent(new Event('change'))
    })

    expect(screen.getByRole('status').textContent).toBe('system:light')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(screen.getByRole('button', { name: '切换到深色模式' })).toBeDefined()
    expect(window.localStorage.getItem('ui-theme')).toBeNull()
  })

  it('使用与后台相同的页面渐变，减少动态效果时直接切换', () => {
    document.documentElement.classList.add('dark')
    const startViewTransition = vi.fn((applyTheme: () => void) => {
      applyTheme()
      return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: Promise.resolve(), skipTransition: vi.fn() }
    })
    Object.defineProperty(document, 'startViewTransition', { configurable: true, value: startViewTransition })
    renderTheme()
    expect(startViewTransition).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '切换到浅色模式' }))
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains('light')).toBe(true)

    reducedMotion = true
    fireEvent.click(screen.getByRole('button', { name: '切换到深色模式' }))
    expect(startViewTransition).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('快速连续切换不会被上一次动画的延迟回调覆盖', () => {
    document.documentElement.classList.add('dark')
    const callbacks: Array<() => void> = []
    const skipTransition = vi.fn()
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (applyTheme: () => void) => {
        callbacks.push(applyTheme)
        return { ready: Promise.resolve(), updateCallbackDone: Promise.resolve(), finished: Promise.resolve(), skipTransition }
      },
    })
    renderTheme()

    fireEvent.click(screen.getByRole('button', { name: '切换到浅色模式' }))
    fireEvent.click(screen.getByRole('button', { name: '切换到深色模式' }))
    callbacks.forEach((callback) => callback())

    expect(skipTransition).toHaveBeenCalledTimes(1)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(window.localStorage.getItem('ui-theme')).toBe('dark')
  })

  it('浏览器不允许持久化时仍能切换主题', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    renderTheme()

    fireEvent.click(screen.getByRole('button', { name: '切换到浅色模式' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
  })
})
