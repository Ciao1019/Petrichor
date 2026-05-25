'use client'

import { CircleCheckIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export type Calendar24Value = {
  dueDate: string
  startTime: string
  endTime: string
}

export type Calendar24Props = {
  value: Calendar24Value
  onChange: (value: Calendar24Value) => void
  title?: string
  description?: string
  className?: string
}

function parseLocalDateParts(dateStr: string): { year: number; month: number; day: number } | null {
  if (!dateStr) {
    return null
  }
  const [y, m, d] = dateStr.split('-').map(v => Number(v))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null
  }
  return { year: y, month: m, day: d }
}

function parseLocalDate(dateStr: string): Date | undefined {
  const parts = parseLocalDateParts(dateStr)
  if (!parts) {
    return undefined
  }
  // 使用本地日期构造，避免时区偏移导致显示/保存的日期不一致。
  const date = new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0)
  if (Number.isNaN(date.getTime())) {
    return undefined
  }
  return date
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseTimeParts(timeStr: string): { hour: number; minute: number; second: number } | null {
  if (!timeStr) {
    return null
  }
  const [h, m, s] = timeStr.split(':').map(v => Number(v))
  const hour = h
  const minute = m
  const second = Number.isFinite(s) ? s : 0
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || !Number.isFinite(second)) {
    return null
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null
  }
  return { hour, minute, second }
}

function normalizeTime(timeStr: string): string {
  const parts = parseTimeParts(timeStr)
  if (!parts) {
    return ''
  }
  const { hour, minute, second } = parts
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

function resolveTimeComparable(timeStr: string): number | null {
  const parts = parseTimeParts(timeStr)
  if (!parts) {
    return null
  }
  return parts.hour * 3600 + parts.minute * 60 + parts.second
}

function buildTimeSlots(stepMinutes: number): string[] {
  const totalSlots = Math.floor((24 * 60) / stepMinutes)
  return Array.from({ length: totalSlots }, (_, i) => {
    const totalMinutes = i * stepMinutes
    const hour = Math.floor(totalMinutes / 60)
    const minute = totalMinutes % 60
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
  })
}

function formatTimeShort(timeStr: string): string {
  const parts = parseTimeParts(timeStr)
  if (!parts) {
    return '--'
  }
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`
}

function formatTimeZh(timeStr: string): string {
  const parts = parseTimeParts(timeStr)
  if (!parts) {
    return ''
  }
  const hour = parts.hour
  const minute = String(parts.minute).padStart(2, '0')
  const label = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${label}${hour12}:${minute}`
}

export function Calendar24({ value, onChange, title, description, className }: Calendar24Props) {
  const selectedDate = parseLocalDate(value.dueDate)
  const normalizedStartTime = normalizeTime(value.startTime)
  const normalizedEndTime = normalizeTime(value.endTime)
  const startComparable = resolveTimeComparable(normalizedStartTime)
  const endComparable = resolveTimeComparable(normalizedEndTime)

  const timeSlots = buildTimeSlots(15)

  const normalizedTitle = (title || '').trim()
  const normalizedDescription = (description || '').trim()

  const summary = (() => {
    if (!selectedDate) {
      return '请选择日期与时间。'
    }
    const dateText = selectedDate.toLocaleDateString('zh-CN', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    })

    const titleText = normalizedTitle ? `任务「${normalizedTitle}」` : '任务'
    const descriptionText = normalizedDescription ? `（${normalizedDescription}）` : ''

    if (normalizedStartTime && normalizedEndTime) {
      return `${titleText}${descriptionText}定于${dateText}${formatTimeZh(normalizedStartTime)}开始，${formatTimeZh(normalizedEndTime)}结束。`
    }

    if (normalizedStartTime && !normalizedEndTime) {
      return `${titleText}${descriptionText}已选择开始时间：${dateText}${formatTimeZh(normalizedStartTime)}，请继续选择结束时间。`
    }

    if (!normalizedStartTime && normalizedEndTime) {
      return `${titleText}${descriptionText}已选择结束时间：${dateText}${formatTimeZh(normalizedEndTime)}，请先选择开始时间。`
    }

    return `${titleText}${descriptionText}已选择日期：${dateText}（未设置时间，默认全天）。`
  })()

  const selectDate = (next: Date | undefined) => {
    if (!next) {
      onChange({ dueDate: '', startTime: '', endTime: '' })
      return
    }
    onChange({ ...value, dueDate: formatLocalDate(next) })
  }

  const clearTimeRange = () => {
    onChange({ ...value, startTime: '', endTime: '' })
  }

  const clearAll = () => {
    onChange({ dueDate: '', startTime: '', endTime: '' })
  }

  const selectTimeSlot = (time: string) => {
    // 时间段选择交互：首次点击选开始；第二次点击选结束；已有完整范围时再次点击会重新开始选择。
    if (!selectedDate) {
      return
    }
    const normalized = normalizeTime(time)
    if (!normalized) {
      return
    }
    if (!normalizedStartTime || (normalizedStartTime && normalizedEndTime)) {
      onChange({ ...value, startTime: normalized, endTime: '' })
      return
    }

    const start = resolveTimeComparable(normalizedStartTime)
    const end = resolveTimeComparable(normalized)
    if (start == null || end == null) {
      onChange({ ...value, startTime: normalized, endTime: '' })
      return
    }
    if (start <= end) {
      onChange({ ...value, startTime: normalizedStartTime, endTime: normalized })
      return
    }
    onChange({ ...value, startTime: normalized, endTime: normalizedStartTime })
  }

  return (
    <Card className={cn('gap-0 !py-0', className)}>
      <CardContent className='!p-0'>
        <div className='flex flex-col md:flex-row'>
          <div className='flex-1 border-b p-4 md:border-b-0 md:border-r'>
            <Calendar
              mode='single'
              selected={selectedDate}
              onSelect={selectDate}
              defaultMonth={selectedDate}
              showOutsideDays={false}
              className='bg-transparent p-0 [--cell-size:--spacing(9)]'
            />
            <div className='mt-3 flex flex-wrap items-center justify-center gap-2'>
              <Button
                variant='ghost'
                size='sm'
                onClick={clearTimeRange}
                disabled={!value.startTime && !value.endTime}
                className="text-muted-foreground hover:text-foreground h-7"
              >
                清除时间
              </Button>
              <Button
                variant='ghost'
                size='sm'
                onClick={clearAll}
                disabled={!value.dueDate && !value.startTime && !value.endTime}
                className="text-muted-foreground hover:text-foreground h-7"
              >
                清除全部
              </Button>
            </div>
          </div>

          <div className='flex w-full flex-col md:w-72'>
            <div className='shrink-0 border-b p-3 min-h-[4.5rem] flex flex-col justify-center'>
              <div className='flex items-baseline justify-between'>
                <div className='text-sm font-medium opacity-70'>时间段</div>
                {/* 保持占位或显示简单提示，或者直接隐藏Label */}
              </div>
              <div className='mt-2 flex items-center gap-2 text-base font-semibold'>
                <span className={cn(normalizedStartTime ? "text-foreground" : "text-muted-foreground/40")}>
                  {normalizedStartTime ? formatTimeShort(normalizedStartTime) : '00:00'}
                </span>
                <span className="text-muted-foreground/40">-</span>
                <span className={cn(normalizedEndTime ? "text-foreground" : "text-muted-foreground/40")}>
                  {normalizedEndTime ? formatTimeShort(normalizedEndTime) : '00:00'}
                </span>
              </div>
              <div className='mt-1 text-xs text-muted-foreground/60 h-4'>
                {selectedDate
                  ? normalizedStartTime && !normalizedEndTime
                    ? '请选择结束时间'
                    : !normalizedStartTime
                      ? '点击选择开始时间'
                      : '已有完整时间段'
                  : '请先选择日期'}
              </div>
            </div>

            <ScrollArea className='h-44 md:h-[17.5rem]'>
              <div className='grid grid-cols-4 gap-1.5 p-3'>
                {timeSlots.map(time => {
                  const timeComparable = resolveTimeComparable(time)
                  const isStart = startComparable != null && timeComparable === startComparable
                  const isEnd = endComparable != null && timeComparable === endComparable
                  const isInRange =
                    startComparable != null &&
                    endComparable != null &&
                    timeComparable != null &&
                    timeComparable > Math.min(startComparable, endComparable) &&
                    timeComparable < Math.max(startComparable, endComparable)

                  const stateClassName =
                    isStart || isEnd
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                      : isInRange
                        ? 'bg-primary/10 text-primary hover:bg-primary/20'
                        : 'hover:bg-accent hover:text-accent-foreground text-muted-foreground'

                  return (
                    <Button
                      key={time}
                      variant='ghost'
                      size='sm'
                      onClick={() => selectTimeSlot(time)}
                      className={cn('w-full h-7 px-0 !shadow-none font-normal transition-colors', stateClassName)}
                      disabled={!selectedDate}
                    >
                      <span className="text-[11px]">{formatTimeShort(time)}</span>
                    </Button>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        </div>
      </CardContent>

      <CardFooter className='flex flex-col gap-3 border-t px-4 !py-3 bg-muted/20'>
        <div className='flex items-start gap-2 text-sm w-full'>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {selectedDate && normalizedStartTime && normalizedEndTime ? (
                <CircleCheckIcon className='size-4 shrink-0 text-green-600 dark:text-green-400' />
              ) : null}
              <span className="font-medium text-foreground">当前选择</span>
            </div>
            <p className='text-xs text-muted-foreground break-words leading-relaxed'>{summary}</p>
          </div>
        </div>
      </CardFooter>
    </Card>
  )
}

export default Calendar24
