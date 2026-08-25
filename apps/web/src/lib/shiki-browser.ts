import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  normalizeTheme,
  stringifyTokenStyle,
} from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { createOnigurumaEngine } from "shiki/engine/oniguruma"

/**
 * 浏览器端只保留产品里实际常见的语言。
 *
 * shiki 默认入口会为全部语言和主题生成数百个动态 chunk；Lobe Markdown、
 * @pierre/diffs 和项目代码各自引用时还会重复生成。Vite 生产构建因此在 Vercel
 * 的 8 GB 构建机上 OOM 或卡满 45 分钟。这里保留三方所需的兼容导出，但把
 * 自动加载范围收敛到常用 Web、配置、脚本和后端语言。
 */
export const bundledLanguages = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} as const

export const bundledThemes = {
  "dark-plus": () => import("@shikijs/themes/dark-plus"),
  "github-dark": () => import("@shikijs/themes/github-dark"),
  "github-light": () => import("@shikijs/themes/github-light"),
  "light-plus": () => import("@shikijs/themes/light-plus"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  "vitesse-dark": () => import("@shikijs/themes/vitesse-dark"),
  "vitesse-light": () => import("@shikijs/themes/vitesse-light"),
} as const

type LanguageInfo = {
  id: keyof typeof bundledLanguages
  name: string
  aliases?: string[]
}

export const bundledLanguagesInfo: LanguageInfo[] = [
  { id: "bash", name: "Bash", aliases: ["sh"] },
  { id: "c", name: "C" },
  { id: "cpp", name: "C++", aliases: ["c++"] },
  { id: "csharp", name: "C#", aliases: ["cs"] },
  { id: "css", name: "CSS" },
  { id: "diff", name: "Diff" },
  { id: "dockerfile", name: "Dockerfile", aliases: ["docker"] },
  { id: "go", name: "Go" },
  { id: "graphql", name: "GraphQL" },
  { id: "html", name: "HTML" },
  { id: "java", name: "Java" },
  { id: "javascript", name: "JavaScript", aliases: ["js", "cjs", "mjs"] },
  { id: "json", name: "JSON" },
  { id: "jsonc", name: "JSON with Comments" },
  { id: "jsx", name: "JSX" },
  { id: "kotlin", name: "Kotlin", aliases: ["kt", "kts"] },
  { id: "markdown", name: "Markdown", aliases: ["md"] },
  { id: "php", name: "PHP" },
  { id: "powershell", name: "PowerShell", aliases: ["ps1"] },
  { id: "python", name: "Python", aliases: ["py"] },
  { id: "ruby", name: "Ruby", aliases: ["rb"] },
  { id: "rust", name: "Rust", aliases: ["rs"] },
  { id: "shellscript", name: "Shell", aliases: ["shell", "zsh"] },
  { id: "sql", name: "SQL" },
  { id: "swift", name: "Swift" },
  { id: "toml", name: "TOML" },
  { id: "tsx", name: "TSX" },
  { id: "typescript", name: "TypeScript", aliases: ["ts"] },
  { id: "vue", name: "Vue" },
  { id: "xml", name: "XML" },
  { id: "yaml", name: "YAML", aliases: ["yml"] },
]

export const bundledThemesInfo = [
  { id: "dark-plus", displayName: "Dark Plus", type: "dark" },
  { id: "github-dark", displayName: "GitHub Dark", type: "dark" },
  { id: "github-light", displayName: "GitHub Light", type: "light" },
  { id: "light-plus", displayName: "Light Plus", type: "light" },
  { id: "one-dark-pro", displayName: "One Dark Pro", type: "dark" },
  { id: "vitesse-dark", displayName: "Vitesse Dark", type: "dark" },
  { id: "vitesse-light", displayName: "Vitesse Light", type: "light" },
] as const

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: () => createJavaScriptRegexEngine(),
})

const shorthands = createSingletonShorthands(createHighlighter)

export const codeToHtml = shorthands.codeToHtml
export const getSingletonHighlighter = shorthands.getSingletonHighlighter

export {
  createCssVariablesTheme,
  createJavaScriptRegexEngine,
  createOnigurumaEngine,
  getTokenStyleObject,
  normalizeTheme,
  stringifyTokenStyle,
}
