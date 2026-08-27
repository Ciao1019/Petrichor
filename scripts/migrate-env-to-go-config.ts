import { chmod, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const repositoryRoot = path.resolve(import.meta.dir, "..")
const webEnvPath = path.join(repositoryRoot, "apps/web/.env.local")
const webDevelopmentEnvPath = path.join(repositoryRoot, "apps/web/.env.development.local")
const goConfigPath = path.join(repositoryRoot, "apps/api/config.toml")

const webSource = await readOptionalFile(webEnvPath)
const developmentSource = await readOptionalFile(webDevelopmentEnvPath)
const webEnv = parseEnv(webSource)
const developmentEnv = parseEnv(developmentSource)
const sourceEnv = new Map([...webEnv, ...developmentEnv])

const value = (key: string, ...fallbackKeys: string[]) => {
    for (const candidate of [key, ...fallbackKeys]) {
        const found = sourceEnv.get(candidate)?.trim()
        if (found) return found
    }
    return ""
}
const integer = (key: string, fallback: number) => {
    const parsed = Number(value(key))
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}
const boolean = (key: string, fallback: boolean) => {
    const raw = value(key).toLowerCase()
    if (["true", "1", "yes", "y"].includes(raw)) return true
    if (["false", "0", "no", "n"].includes(raw)) return false
    return fallback
}
const quote = (input: string) => JSON.stringify(input)

const config = `[server]
environment = "development"
host = "0.0.0.0"
port = ${integer("PETRICHOR_API_PORT", 8080)}
base_url = ${quote(value("NEXT_PUBLIC_APP_URL", "APP_BASE_URL") || "http://localhost:3000")}

[database]
url = ${quote(value("DATABASE_URL"))}
migration_url = ${quote(value("MIGRATION_DATABASE_URL"))}

[auth]
session_secret = ${quote(value("SESSION_SECRET"))}
session_expire_seconds = ${integer("PETRICHOR_SESSION_EXPIRE_SECONDS", 172800)}
register_enabled = ${boolean("NEXT_PUBLIC_REGISTER_ENABLED", false)}
default_system_role = ${quote(value("PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE") || "USER")}

[auth.linuxdo]
client_id = ${quote(value("PETRICHOR_LINUXDO_CLIENT_ID", "LINUXDO_CLIENT_ID"))}
client_secret = ${quote(value("PETRICHOR_LINUXDO_CLIENT_SECRET", "LINUXDO_CLIENT_SECRET"))}
redirect_uri = ${quote(value("PETRICHOR_LINUXDO_REDIRECT_URI", "LINUXDO_REDIRECT_URI"))}

[auth.local_development]
enabled = ${boolean("PETRICHOR_LOCAL_AUTH_BYPASS", false)}
user_id = ${integer("PETRICHOR_LOCAL_USER_ID", 0)}

[encryption]
key = ${quote(value("PETRICHOR_ENCRYPT_KEY", "AI_CONFIG_ENCRYPT_KEY"))}
salt = ${quote(value("PETRICHOR_ENCRYPT_SALT", "AI_CONFIG_ENCRYPT_SALT"))}

[storage]
local_directory = ${quote(value("PETRICHOR_STORAGE_DIR"))}

[storage.s3]
endpoint = ${quote(value("S3_ENDPOINT"))}
region = ${quote(value("S3_REGION") || "us-east-1")}
access_key_id = ${quote(value("S3_ACCESS_KEY_ID"))}
secret_access_key = ${quote(value("S3_SECRET_ACCESS_KEY"))}
bucket = ${quote(value("S3_BUCKET"))}
upload_expire_seconds = ${integer("S3_UPLOAD_EXPIRE_SECONDS", 900)}
download_expire_seconds = ${integer("S3_DOWNLOAD_EXPIRE_SECONDS", 3600)}
use_ssl = ${boolean("S3_USE_SSL", true)}

[cache.upstash]
rest_url = ${quote(value("UPSTASH_REDIS_REST_URL"))}
rest_token = ${quote(value("UPSTASH_REDIS_REST_TOKEN"))}

[agent]
skills_directory = ${quote(value("PETRICHOR_SKILLS_DIR"))}

[agent.features]
runtime_v2 = ${boolean("AGENT_RUNTIME_V2", true)}
soft_router = ${boolean("SOFT_ROUTER_ENABLED", true)}
dynamic_skills = ${boolean("AGENT_DYNAMIC_SKILLS", true)}
delegation = ${boolean("AGENT_DELEGATION", true)}
debug = ${boolean("AGENT_DEBUG", false)}

[agent.budget]
max_execution_ms = ${integer("AGENT_MAX_EXECUTION_MS", 0)}
max_tokens = ${integer("AGENT_MAX_TOKENS", 0)}
max_delegation_depth = ${integer("AGENT_MAX_DELEGATION_DEPTH", 2)}
max_no_progress = ${integer("AGENT_MAX_NO_PROGRESS", 3)}
tool_timeout_ms = ${integer("AGENT_TOOL_TIMEOUT_MS", 45000)}
tool_max_retries = ${integer("AGENT_TOOL_MAX_RETRIES", 1)}
subagent_timeout_ms = ${integer("AGENT_SUBAGENT_TIMEOUT_MS", 120000)}
context_tokens = ${integer("AGENT_CONTEXT_TOKENS", 100000)}

[agent.budget.direct]
max_iterations = ${integer("AGENT_MAX_ITERATIONS_DIRECT", 1)}
max_tool_calls = ${integer("AGENT_MAX_TOOL_CALLS_DIRECT", 0)}
max_subagents = 0

[agent.budget.simple]
max_iterations = ${integer("AGENT_MAX_ITERATIONS_SIMPLE", 4)}
max_tool_calls = ${integer("AGENT_MAX_TOOL_CALLS_SIMPLE", 4)}
max_subagents = 0

[agent.budget.multi_step]
max_iterations = ${integer("AGENT_MAX_ITERATIONS_MULTI_STEP", 12)}
max_tool_calls = ${integer("AGENT_MAX_TOOL_CALLS_MULTI_STEP", 14)}
max_subagents = 2

[agent.budget.complex]
max_iterations = ${integer("AGENT_MAX_ITERATIONS_COMPLEX", 24)}
max_tool_calls = ${integer("AGENT_MAX_TOOL_CALLS_COMPLEX", 32)}
max_subagents = 5

[agent.model]
base_url = ${quote(value("AGENT_OPENAI_BASE_URL"))}
api_key = ${quote(value("AGENT_OPENAI_API_KEY"))}
model = ${quote(value("AGENT_MODEL"))}
`

await writeFile(goConfigPath, config, { encoding: "utf8", flag: "wx", mode: 0o600 })
await chmod(goConfigPath, 0o600)
await writeFrontendEnv(webEnvPath, webEnv)
await writeFrontendEnv(webDevelopmentEnvPath, developmentEnv)

console.log("已生成 apps/api/config.toml，并从 Web 环境文件移除后端配置。")

async function readOptionalFile(filePath: string) {
    try {
        return await readFile(filePath, "utf8")
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return ""
        throw error
    }
}

function parseEnv(source: string) {
    const entries = new Map<string, string>()
    for (const line of source.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
        if (!match) continue
        entries.set(match[1], parseEnvValue(match[2]))
    }
    return entries
}

function parseEnvValue(raw: string) {
    const value = raw.trim()
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            return JSON.parse(value) as string
        } catch {
            return value.slice(1, -1)
        }
    }
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1)
    }
    return value
}

function isFrontendKey(key: string) {
    return key.startsWith("VITE_")
        || key.startsWith("NEXT_PUBLIC_")
        || key.startsWith("PETRICHOR_PUBLIC_")
        || key === "PETRICHOR_GO_API_URL"
}

async function writeFrontendEnv(filePath: string, entries: Map<string, string>) {
    const frontendEntries = [...entries].filter(([key]) => isFrontendKey(key))
    if (frontendEntries.length === 0) {
        await unlink(filePath).catch((error) => {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        })
        return
    }
    const body = [
        "# 仅供 Bun/Vite 前端使用；Go 后端配置位于 apps/api/config.toml。",
        ...frontendEntries.map(([key, entryValue]) => `${key}=${quote(entryValue)}`),
        "",
    ].join("\n")
    await writeFile(filePath, body, "utf8")
}
