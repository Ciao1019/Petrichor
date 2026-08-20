/*
 * Wiki 内链的手绘波浪下划线 —— 沿用「关于我」页 desk accents 的马克笔语言
 * （见 features/pages/about/DeskAccents.tsx 的 HandUnderline）。
 *
 * 与 About 页的区别：那里的波浪是一段绝对定位的 <svg>，靠 inline-block + whitespace-nowrap
 * 撑住；正文内链随时可能折行，绝对定位会把线画到错的位置，所以这里把同一条波浪塞进
 * background-image，配合 box-decoration-break: clone —— 折行后每一段都自带一条完整的波浪。
 */

import type { CSSProperties } from "react"

/** 与 app/about-desk.css 的 --desk-marker-* 同色：data URI 里没法引用 CSS 变量，只能取字面值。 */
const SCRIBBLE_INKS = [
  "#f0806e",
  "#f0a95f",
  "#6fc48c",
  "#4fc4b4",
  "#7d99e0",
  "#a68ce0",
  "#ec7cba",
] as const

/** 起伏不同的几条线，免得一段话里所有内链都描着同一道波浪 */
const SCRIBBLE_PATHS = [
  "M2,6 C22,2 40,9 58,5 C78,1 98,9 118,4",
  "M2,5 C20,9 38,2 58,6 C76,9 98,2 118,6",
  "M2,7 C24,3 42,8 60,4 C80,1 96,8 118,5",
] as const

function hashSeed(seed: string) {
  let hash = 0
  for (let index = 0; index < seed.length; index += 1) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) >>> 0
  }
  return hash
}

function scribbleImage(path: string, ink: string) {
  // preserveAspectRatio="none"：让波浪横向拉伸到词的宽度，短词一道浅弯、长词一道长弯
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 10" preserveAspectRatio="none">' +
    `<path d="${path}" fill="none" stroke="${ink}" stroke-width="2.2" stroke-linecap="round"/>` +
    "</svg>"
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/**
 * 按 seed（内链的 href）稳定地挑一支马克笔与一条波浪：
 * 同一个词每次渲染都是同一个颜色，词与词之间则像是随手换了支笔。
 * 用真随机的话，每次重渲染都会闪色。
 */
export function wikiScribbleStyle(seed: string): CSSProperties {
  const hash = hashSeed(seed)
  return {
    backgroundImage: scribbleImage(
      SCRIBBLE_PATHS[hash % SCRIBBLE_PATHS.length],
      SCRIBBLE_INKS[(hash >>> 3) % SCRIBBLE_INKS.length],
    ),
    backgroundRepeat: "no-repeat",
    // 贴着 padding 底边铺一条 0.4em 高的墨带，让笔画落在文字下缘外侧
    backgroundPosition: "0 100%",
    backgroundSize: "100% 0.4em",
    paddingBottom: "0.22em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
  }
}
