'use client'

import type { MutableRefObject } from 'react'
import type { DateRange } from 'react-day-picker'

const DAY_MS = 86400000
const MIN_SOUND_INTERVAL = 80
const TICK_VOLUME = 0.03
const TICK_BUFFER_SECONDS = 0.003

export const CELL = 36
export const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日']
export const CORNER_RADIUS = '10px'
export const MONTH_CHANGE_SHIFT = 12

export type MonthCursor = {
  year: number
  month: number
}

export type EffectiveRange = {
  start: string | null
  end: string | null
}

let tickAudioContext: AudioContext | null = null
let tickAudioBuffer: AudioBuffer | null = null

export function toKey(year: number, month: number, day: number): string {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`
}

export function dateToKey(date: Date): string {
  return toKey(date.getFullYear(), date.getMonth(), date.getDate())
}

export function keyToDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function normalizeDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function shiftMonth(cursor: MonthCursor, delta: number): MonthCursor {
  const total = cursor.year * 12 + cursor.month + delta
  return {
    year: Math.floor(total / 12),
    month: ((total % 12) + 12) % 12
  }
}

export function toLocalDateLabel(value: Date): string {
  return value.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

export function daysBetween(fromKey: string, toKeyValue: string): number {
  const from = keyToDate(fromKey).getTime()
  const to = keyToDate(toKeyValue).getTime()
  return Math.round((to - from) / DAY_MS) + 1
}

export function playTick(lastTickRef: MutableRefObject<number>, enabled: boolean) {
  if (!enabled) return
  const now = performance.now()
  if (now - lastTickRef.current < MIN_SOUND_INTERVAL) return
  lastTickRef.current = now
  try {
    const context = getTickContext()
    const source = context.createBufferSource()
    const gain = context.createGain()
    source.buffer = getTickBuffer(context)
    source.playbackRate.value = 1.15
    gain.gain.value = TICK_VOLUME
    source.connect(gain)
    gain.connect(context.destination)
    source.start()
  } catch {
    // 音频能力不可用时静默降级，保持日期选择功能可用。
  }
}

export function getEffectiveRange(value: DateRange | undefined, hoverKey: string | null): EffectiveRange {
  if (!value?.from) {
    return { start: null, end: null }
  }
  const startKey = dateToKey(value.from)
  if (value.to) {
    const endKey = dateToKey(value.to)
    const [start, end] = orderKeys(startKey, endKey)
    return { start, end }
  }
  if (hoverKey) {
    const [start, end] = orderKeys(startKey, hoverKey)
    return { start, end }
  }
  return { start: startKey, end: null }
}

export function inRange(dateKey: string, range: EffectiveRange): boolean {
  if (!range.start || !range.end) return false
  return dateKey >= range.start && dateKey <= range.end
}

export function isSameDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function orderKeys(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a]
}

function getTickContext() {
  if (!tickAudioContext) {
    tickAudioContext = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  }
  if (tickAudioContext.state === 'suspended') {
    void tickAudioContext.resume()
  }
  return tickAudioContext
}

function getTickBuffer(context: AudioContext) {
  if (tickAudioBuffer && tickAudioBuffer.sampleRate === context.sampleRate) {
    return tickAudioBuffer
  }
  const length = Math.floor(context.sampleRate * TICK_BUFFER_SECONDS)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) {
    const t = i / length
    channel[i] = (Math.random() * 2 - 1) * (1 - t) ** 4
  }
  tickAudioBuffer = buffer
  return buffer
}
