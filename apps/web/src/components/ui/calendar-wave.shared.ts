export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

export const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

export const CELL_SIZE = 40
export const CELL_GAP = 2
export const CELL_STEP = CELL_SIZE + CELL_GAP
export const WAVE_RADIUS = 110
export const MAX_LIFT = 8

const SOUND_THROTTLE_MS = 60
const SOUND_SECONDS = 0.003
const SOUND_DECAY_POWER = 4
const SOUND_BASE_VOLUME = 0.12

let audioCtx: AudioContext | null = null
let audioBuf: AudioBuffer | null = null
let lastSoundAt = 0

export type CalendarCell = {
  day: number | null
  col: number
  row: number
}

export function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

export function startOffset(year: number, month: number) {
  return (new Date(year, month, 1).getDay() + 6) % 7
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

export function toDateKey(year: number, month: number, day: number) {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

export function parseDateKey(key: string) {
  const [y, m, d] = key.split("-").map(Number)
  if (!y || !m || !d) return null
  return { year: y, month: m - 1, day: d }
}

export function calculateWaveLift(mouseX: number, mouseY: number, col: number, row: number) {
  const centerX = col * CELL_STEP + CELL_SIZE / 2
  const centerY = row * CELL_STEP + CELL_SIZE / 2
  const dx = mouseX - centerX
  const dy = mouseY - centerY
  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance >= WAVE_RADIUS) return 0
  const t = distance / WAVE_RADIUS
  return (MAX_LIFT * (1 + Math.cos(Math.PI * t))) / 2
}

function initSound() {
  if (audioCtx) return
  audioCtx = new AudioContext()
  const sampleCount = Math.ceil(audioCtx.sampleRate * SOUND_SECONDS)
  audioBuf = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate)
  const channel = audioBuf.getChannelData(0)
  for (let i = 0; i < sampleCount; i++) {
    const t = i / sampleCount
    channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, SOUND_DECAY_POWER) * SOUND_BASE_VOLUME
  }
}

export function playCalendarWaveTick() {
  const now = Date.now()
  if (now - lastSoundAt < SOUND_THROTTLE_MS) return
  lastSoundAt = now
  initSound()
  if (!audioCtx || !audioBuf) return
  const source = audioCtx.createBufferSource()
  source.buffer = audioBuf
  source.connect(audioCtx.destination)
  source.start()
}
