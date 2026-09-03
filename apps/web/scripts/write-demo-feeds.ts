import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import { buildDemoPublicArticleList } from "../src/lib/demo/demo-public-data"

const distDirectory = join(import.meta.dir, "..", "dist")
const baseUrl = (process.env.PETRICHOR_DEMO_BASE_URL || "https://petrichor-demo.vercel.app").replace(/\/+$/, "")
const items = buildDemoPublicArticleList().filter((item) => !item.expired && !item.hasPassword).slice(0, 50)
const latest = items.reduce((value, item) => Math.max(value, Date.parse(item.updatedAt) || 0), 0)
const latestDate = new Date(latest || Date.now())

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function absoluteUrl(path: string) {
  return path.startsWith("http://") || path.startsWith("https://")
    ? path
    : `${baseUrl}/${path.replace(/^\/+/, "")}`
}

const rssItems = items.map((item) => {
  const link = absoluteUrl(item.href)
  const categories = item.tags.map((tag) => `      <category>${escapeXml(tag)}</category>`).join("\n")
  return `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <description>${escapeXml(item.excerpt)}</description>
      <pubDate>${new Date(item.updatedAt).toUTCString()}</pubDate>${categories ? `\n${categories}` : ""}
    </item>`
}).join("\n")

const atomEntries = items.map((item) => {
  const link = absoluteUrl(item.href)
  const categories = item.tags.map((tag) => `    <category term="${escapeXml(tag)}"></category>`).join("\n")
  return `  <entry>
    <title>${escapeXml(item.title)}</title>
    <id>${escapeXml(link)}</id>
    <link href="${escapeXml(link)}"></link>
    <updated>${new Date(item.updatedAt).toISOString()}</updated>
    <published>${new Date(item.updatedAt).toISOString()}</published>
    <summary>${escapeXml(item.excerpt)}</summary>${categories ? `\n${categories}` : ""}
  </entry>`
}).join("\n")

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Petrichor Demo</title>
    <link>${baseUrl}/</link>
    <description>公开知识、语义 Wiki 与关系探索平台</description>
    <language>zh-CN</language>
    <lastBuildDate>${latestDate.toUTCString()}</lastBuildDate>
${rssItems}
  </channel>
</rss>
`

const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Petrichor Demo</title>
  <id>${baseUrl}/</id>
  <updated>${latestDate.toISOString()}</updated>
  <link href="${baseUrl}/"></link>
  <link href="${baseUrl}/atom.xml" rel="self" type="application/atom+xml"></link>
  <author><name>Petrichor</name></author>
${atomEntries}
</feed>
`

await mkdir(distDirectory, { recursive: true })
await Promise.all([
  Bun.write(join(distDirectory, "rss.xml"), rss),
  Bun.write(join(distDirectory, "atom.xml"), atom),
])
console.log(`已生成 Demo RSS / Atom（${items.length} 篇公开文章）`)
