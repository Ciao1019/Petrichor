/**
 * 供应商目录（Provider Catalog）
 *
 * 参考 new-api「渠道类型」和 Vercel AI Gateway「provider registry」的做法：
 * 供应商是一份内置的静态清单，用户只挑选 + 填凭证，不需要背 BaseUrl，
 * 也不需要手输模型名——模型由 `provider-models.ts` 按 listing 策略在线拉取。
 *
 * 这里只放纯数据和纯函数，不 import 任何 @ai-sdk 包，
 * 这样前端也能直接复用同一份类型定义（见 `@/lib/api`）。
 */

/** 模型用途分类：语言模型（含多模态）与向量模型走完全不同的 SDK 入口 */
export type ProviderModelKind = "LANGUAGE" | "EMBEDDING"

/** 模型能力标记，用于 UI 过滤和用途绑定校验 */
export type ModelCapability = "tools" | "vision" | "reasoning" | "json"

/**
 * 底层走哪个 @ai-sdk 包。多数国内厂商没有官方包，
 * 统一走 `openai-compatible`，但在目录里仍然是独立供应商（自带默认 BaseUrl）。
 */
export type ProviderSdk =
    | "openai"
    | "openai-compatible"
    | "anthropic"
    | "google"
    | "google-vertex"
    | "azure"
    | "amazon-bedrock"
    | "xai"
    | "mistral"
    | "cohere"
    | "groq"
    | "cerebras"
    | "deepseek"
    | "deepinfra"
    | "togetherai"
    | "fireworks"
    | "perplexity"
    | "baseten"
    | "huggingface"
    | "moonshotai"
    | "alibaba"
    | "minimax"
    | "voyage"
    | "gateway"

/**
 * 语言模型走哪套 HTTP 协议。
 *
 * - `chat`      OpenAI Chat Completions（POST {baseUrl}/chat/completions）
 * - `responses` OpenAI Responses API（POST {baseUrl}/responses）
 *
 * 这个选择必须显式化，不能依赖 SDK 默认值：`@ai-sdk/openai` v4 起
 * `provider.languageModel(id)` 默认返回 Responses 模型，而绝大多数「OpenAI 兼容」
 * 的中转网关、私有部署和本地推理服务只实现了 /chat/completions，
 * 直接用默认值会在这些接入上 404。
 */
export type ApiProtocol = "chat" | "responses"

/**
 * 在线拉取模型列表的方式。
 * - `openai`     GET {baseUrl}/models，Bearer 鉴权，响应 { data: [{ id }] }
 * - `anthropic`  GET {baseUrl}/models，x-api-key + anthropic-version
 * - `google`     GET {baseUrl}/models?key=xxx，响应 { models: [{ name: "models/xxx" }] }
 * - `cohere`     GET {baseUrl}/models?page_size=1000，响应 { models: [{ name, endpoints }] }
 * - `none`       该供应商没有公开的模型列表接口，只能用内置清单
 */
export type ModelListingMode = "openai" | "anthropic" | "google" | "cohere" | "none"

/** 供应商特有的额外凭证字段（Bedrock 的 AK/SK、Vertex 的服务账号等） */
export interface CredentialField {
    key: string
    label: string
    placeholder?: string
    required: boolean
    /** true 表示存库要加密、回显要打码 */
    secret: boolean
}

/** 内置模型清单条目：拉不到在线列表时的兜底，也用于补全上下文窗口和能力标记 */
export interface CatalogModel {
    id: string
    kind: ProviderModelKind
    label?: string
    contextWindow?: number
    capabilities?: ModelCapability[]
}

export interface ProviderDefinition {
    key: string
    name: string
    /** 一句话说明，显示在供应商选择器里 */
    description: string
    /** UI 徽章配色 token */
    accent: "emerald" | "orange" | "blue" | "violet" | "amber" | "rose" | "cyan" | "slate"
    /** 默认 BaseUrl，用户可覆盖；null 表示必须自己填 */
    defaultBaseUrl: string | null
    /** 为 true 时 BaseUrl 是必填项（自定义兼容端点、私有部署） */
    baseUrlRequired: boolean
    sdk: ProviderSdk
    /** 该供应商能提供哪几类模型 */
    kinds: ProviderModelKind[]
    /**
     * 该 SDK 支持切换的语言模型协议。只有一项时用户不需要选。
     * 顺序有意义：第一项是默认值。
     */
    apiProtocols?: ApiProtocol[]
    listing: ModelListingMode
    /** API Key 之外还需要的字段 */
    credentialFields: CredentialField[]
    /** 内置兜底模型清单 */
    models: CatalogModel[]
    docUrl: string
}

const BEDROCK_FIELDS: CredentialField[] = [
    { key: "region", label: "Region", placeholder: "us-east-1", required: true, secret: false },
    { key: "accessKeyId", label: "Access Key ID", required: true, secret: false },
    { key: "secretAccessKey", label: "Secret Access Key", required: true, secret: true },
    { key: "sessionToken", label: "Session Token（可选）", required: false, secret: true },
]

const VERTEX_FIELDS: CredentialField[] = [
    { key: "project", label: "GCP Project ID", required: true, secret: false },
    { key: "location", label: "Location", placeholder: "us-central1", required: true, secret: false },
    { key: "clientEmail", label: "Service Account Email", required: true, secret: false },
    { key: "privateKey", label: "Service Account Private Key", required: true, secret: true },
]

const AZURE_FIELDS: CredentialField[] = [
    { key: "resourceName", label: "资源名称", placeholder: "my-openai-resource", required: true, secret: false },
    { key: "apiVersion", label: "API Version（可选）", placeholder: "2024-10-01-preview", required: false, secret: false },
]

/**
 * 供应商清单。新增供应商只需要在这里加一条：
 * 有官方 @ai-sdk 包的填对应 sdk，没有的填 `openai-compatible` 并给上默认 BaseUrl。
 */
export const PROVIDER_CATALOG: ProviderDefinition[] = [
    {
        key: "openai",
        name: "OpenAI",
        description: "GPT 系列、o 系列推理模型与 text-embedding 向量模型",
        accent: "emerald",
        defaultBaseUrl: "https://api.openai.com/v1",
        baseUrlRequired: false,
        sdk: "openai",
        kinds: ["LANGUAGE", "EMBEDDING"],
        // 官方端点两套协议都支持；默认 chat，中转网关基本只实现了 /chat/completions
        apiProtocols: ["chat", "responses"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://platform.openai.com/docs/models",
        models: [
            { id: "gpt-5.2", kind: "LANGUAGE", contextWindow: 400_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "gpt-5.1", kind: "LANGUAGE", contextWindow: 400_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "gpt-5", kind: "LANGUAGE", contextWindow: 400_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "gpt-5-mini", kind: "LANGUAGE", contextWindow: 400_000, capabilities: ["tools", "vision", "json"] },
            { id: "gpt-4.1", kind: "LANGUAGE", contextWindow: 1_047_576, capabilities: ["tools", "vision", "json"] },
            { id: "gpt-4o", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["tools", "vision", "json"] },
            { id: "text-embedding-3-large", kind: "EMBEDDING" },
            { id: "text-embedding-3-small", kind: "EMBEDDING" },
        ],
    },
    {
        key: "anthropic",
        name: "Anthropic",
        description: "Claude 系列，原生 /v1/messages，支持 prompt caching 与 thinking",
        accent: "orange",
        defaultBaseUrl: "https://api.anthropic.com/v1",
        baseUrlRequired: false,
        sdk: "anthropic",
        kinds: ["LANGUAGE"],
        listing: "anthropic",
        credentialFields: [],
        docUrl: "https://docs.anthropic.com/en/docs/about-claude/models",
        models: [
            { id: "claude-opus-4-5", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "claude-sonnet-4-5", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "claude-haiku-4-5", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "vision", "json"] },
        ],
    },
    {
        key: "google",
        name: "Google Gemini",
        description: "Gemini 系列，百万级上下文，原生多模态",
        accent: "blue",
        defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
        baseUrlRequired: false,
        sdk: "google",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "google",
        credentialFields: [],
        docUrl: "https://ai.google.dev/gemini-api/docs/models",
        models: [
            { id: "gemini-2.5-pro", kind: "LANGUAGE", contextWindow: 2_000_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "gemini-2.5-flash", kind: "LANGUAGE", contextWindow: 1_000_000, capabilities: ["tools", "vision", "json"] },
            { id: "text-embedding-004", kind: "EMBEDDING" },
        ],
    },
    {
        key: "google-vertex",
        name: "Google Vertex AI",
        description: "GCP 托管的 Gemini 与 Claude，服务账号鉴权",
        accent: "blue",
        defaultBaseUrl: null,
        baseUrlRequired: false,
        sdk: "google-vertex",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "none",
        credentialFields: VERTEX_FIELDS,
        docUrl: "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models",
        models: [
            { id: "gemini-2.5-pro", kind: "LANGUAGE", contextWindow: 2_000_000, capabilities: ["tools", "vision", "reasoning", "json"] },
            { id: "gemini-2.5-flash", kind: "LANGUAGE", contextWindow: 1_000_000, capabilities: ["tools", "vision", "json"] },
            { id: "text-embedding-005", kind: "EMBEDDING" },
        ],
    },
    {
        key: "azure",
        name: "Azure OpenAI",
        description: "Azure 托管的 OpenAI 模型，按部署名调用",
        accent: "cyan",
        defaultBaseUrl: null,
        baseUrlRequired: false,
        sdk: "azure",
        kinds: ["LANGUAGE", "EMBEDDING"],
        apiProtocols: ["chat", "responses"],
        listing: "none",
        credentialFields: AZURE_FIELDS,
        docUrl: "https://learn.microsoft.com/azure/ai-services/openai/concepts/models",
        models: [],
    },
    {
        key: "amazon-bedrock",
        name: "Amazon Bedrock",
        description: "AWS 托管的 Claude / Llama / Titan，SigV4 鉴权",
        accent: "amber",
        defaultBaseUrl: null,
        baseUrlRequired: false,
        sdk: "amazon-bedrock",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "none",
        credentialFields: BEDROCK_FIELDS,
        docUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html",
        models: [
            { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "vision", "json"] },
            { id: "amazon.titan-embed-text-v2:0", kind: "EMBEDDING" },
        ],
    },
    {
        key: "xai",
        name: "xAI Grok",
        description: "Grok 系列，实时联网能力",
        accent: "slate",
        defaultBaseUrl: "https://api.x.ai/v1",
        baseUrlRequired: false,
        sdk: "xai",
        kinds: ["LANGUAGE"],
        apiProtocols: ["chat", "responses"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.x.ai/docs/models",
        models: [
            { id: "grok-4", kind: "LANGUAGE", contextWindow: 256_000, capabilities: ["tools", "vision", "reasoning", "json"] },
        ],
    },
    {
        key: "mistral",
        name: "Mistral AI",
        description: "Mistral / Codestral 系列与 mistral-embed",
        accent: "orange",
        defaultBaseUrl: "https://api.mistral.ai/v1",
        baseUrlRequired: false,
        sdk: "mistral",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.mistral.ai/getting-started/models/models_overview/",
        models: [
            { id: "mistral-large-latest", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["tools", "json"] },
            { id: "mistral-embed", kind: "EMBEDDING" },
        ],
    },
    {
        key: "cohere",
        name: "Cohere",
        description: "Command 系列与 embed 多语言向量模型",
        accent: "rose",
        defaultBaseUrl: "https://api.cohere.com/v2",
        baseUrlRequired: false,
        sdk: "cohere",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "cohere",
        credentialFields: [],
        docUrl: "https://docs.cohere.com/docs/models",
        models: [
            { id: "command-a-03-2025", kind: "LANGUAGE", contextWindow: 256_000, capabilities: ["tools", "json"] },
            { id: "embed-v4.0", kind: "EMBEDDING" },
        ],
    },
    {
        key: "groq",
        name: "Groq",
        description: "LPU 超低延迟推理，托管开源模型",
        accent: "orange",
        defaultBaseUrl: "https://api.groq.com/openai/v1",
        baseUrlRequired: false,
        sdk: "groq",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://console.groq.com/docs/models",
        models: [],
    },
    {
        key: "cerebras",
        name: "Cerebras",
        description: "晶圆级芯片推理，极高吞吐",
        accent: "amber",
        defaultBaseUrl: "https://api.cerebras.ai/v1",
        baseUrlRequired: false,
        sdk: "cerebras",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://inference-docs.cerebras.ai/introduction",
        models: [],
    },
    {
        key: "deepseek",
        name: "DeepSeek",
        description: "深度求索官方接口，思考模式与非思考模式",
        accent: "violet",
        defaultBaseUrl: "https://api.deepseek.com/v1",
        baseUrlRequired: false,
        sdk: "deepseek",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing",
        models: [
            { id: "deepseek-chat", kind: "LANGUAGE", contextWindow: 1_000_000, capabilities: ["tools", "json"] },
            { id: "deepseek-reasoner", kind: "LANGUAGE", contextWindow: 1_000_000, capabilities: ["tools", "reasoning", "json"] },
        ],
    },
    {
        key: "deepinfra",
        name: "Deep Infra",
        description: "开源模型托管，按量计费",
        accent: "cyan",
        defaultBaseUrl: "https://api.deepinfra.com/v1/openai",
        baseUrlRequired: false,
        sdk: "deepinfra",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://deepinfra.com/models",
        models: [],
    },
    {
        key: "togetherai",
        name: "Together AI",
        description: "开源模型托管与微调平台",
        accent: "blue",
        defaultBaseUrl: "https://api.together.xyz/v1",
        baseUrlRequired: false,
        sdk: "togetherai",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.together.ai/docs/serverless-models",
        models: [],
    },
    {
        key: "fireworks",
        name: "Fireworks AI",
        description: "高性能开源模型推理",
        accent: "rose",
        defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
        baseUrlRequired: false,
        sdk: "fireworks",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://fireworks.ai/models",
        models: [],
    },
    {
        key: "perplexity",
        name: "Perplexity",
        description: "Sonar 系列，内建联网检索与引用",
        accent: "cyan",
        defaultBaseUrl: "https://api.perplexity.ai",
        baseUrlRequired: false,
        sdk: "perplexity",
        kinds: ["LANGUAGE"],
        listing: "none",
        credentialFields: [],
        docUrl: "https://docs.perplexity.ai/getting-started/models",
        models: [
            { id: "sonar-pro", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["json"] },
            { id: "sonar", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["json"] },
            { id: "sonar-reasoning-pro", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["reasoning", "json"] },
        ],
    },
    {
        key: "baseten",
        name: "Baseten",
        description: "自托管模型部署平台",
        accent: "violet",
        defaultBaseUrl: "https://inference.baseten.co/v1",
        baseUrlRequired: false,
        sdk: "baseten",
        // Baseten 的向量模型部署在各自独立的 modelURL 上，不能用统一 BaseUrl + 模型名寻址。
        // 需要 Baseten 向量能力时，用「OpenAI 兼容（自定义）」填该 deployment 的专属地址。
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.baseten.co/development/model-apis/overview",
        models: [],
    },
    {
        key: "huggingface",
        name: "Hugging Face",
        description: "HF Router，聚合多家推理供应商",
        accent: "amber",
        defaultBaseUrl: "https://router.huggingface.co/v1",
        baseUrlRequired: false,
        sdk: "huggingface",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://huggingface.co/docs/inference-providers",
        models: [],
    },
    {
        key: "moonshotai",
        name: "Moonshot AI（Kimi）",
        description: "月之暗面 Kimi 系列",
        accent: "slate",
        defaultBaseUrl: "https://api.moonshot.cn/v1",
        baseUrlRequired: false,
        sdk: "moonshotai",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://platform.moonshot.cn/docs/intro",
        models: [],
    },
    {
        key: "alibaba",
        name: "阿里云百炼（通义千问）",
        description: "DashScope 兼容模式，Qwen 全系与 text-embedding",
        accent: "orange",
        defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        baseUrlRequired: false,
        sdk: "alibaba",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://help.aliyun.com/zh/model-studio/models",
        models: [
            { id: "qwen-max", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["tools", "json"] },
            { id: "qwen-plus", kind: "LANGUAGE", contextWindow: 128_000, capabilities: ["tools", "json"] },
            { id: "text-embedding-v4", kind: "EMBEDDING" },
        ],
    },
    {
        key: "minimax",
        name: "MiniMax",
        description: "MiniMax 稀宇科技，abab 与 MiniMax-M 系列",
        accent: "rose",
        defaultBaseUrl: "https://api.minimax.chat/v1",
        baseUrlRequired: false,
        sdk: "minimax",
        kinds: ["LANGUAGE"],
        listing: "none",
        credentialFields: [],
        docUrl: "https://platform.minimaxi.com/document/introduction",
        models: [
            { id: "MiniMax-M2", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "json"] },
        ],
    },
    {
        key: "voyage",
        name: "Voyage AI",
        description: "专注检索的高质量向量与重排模型",
        accent: "violet",
        defaultBaseUrl: "https://api.voyageai.com/v1",
        baseUrlRequired: false,
        sdk: "voyage",
        kinds: ["EMBEDDING"],
        listing: "none",
        credentialFields: [],
        docUrl: "https://docs.voyageai.com/docs/embeddings",
        models: [
            { id: "voyage-3-large", kind: "EMBEDDING" },
            { id: "voyage-3.5", kind: "EMBEDDING" },
            { id: "voyage-code-3", kind: "EMBEDDING" },
        ],
    },
    {
        key: "gateway",
        name: "Vercel AI Gateway",
        description: "一个 Key 直通数百个模型，自带故障转移与用量统计",
        accent: "slate",
        defaultBaseUrl: "https://ai-gateway.vercel.sh/v1",
        baseUrlRequired: false,
        sdk: "gateway",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://vercel.com/docs/ai-gateway",
        models: [],
    },

    // ===== 以下走 @ai-sdk/openai-compatible，但在目录里是一等公民（自带默认 BaseUrl）=====
    {
        key: "siliconflow",
        name: "SiliconFlow（硅基流动）",
        description: "国内开源模型聚合，含 bge-m3 等向量模型",
        accent: "blue",
        defaultBaseUrl: "https://api.siliconflow.cn/v1",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.siliconflow.cn/cn/userguide/introduction",
        models: [
            { id: "BAAI/bge-m3", kind: "EMBEDDING" },
        ],
    },
    {
        key: "openrouter",
        name: "OpenRouter",
        description: "全球模型聚合路由，单 Key 覆盖数百模型",
        accent: "violet",
        defaultBaseUrl: "https://openrouter.ai/api/v1",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://openrouter.ai/docs/models",
        models: [],
    },
    {
        key: "zhipu",
        name: "智谱 AI（GLM）",
        description: "GLM 系列，开放平台兼容接口",
        accent: "cyan",
        defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://docs.bigmodel.cn/cn/guide/start/model-overview",
        models: [
            { id: "glm-4.6", kind: "LANGUAGE", contextWindow: 200_000, capabilities: ["tools", "json"] },
            { id: "embedding-3", kind: "EMBEDDING" },
        ],
    },
    {
        key: "volcengine",
        name: "火山方舟（豆包）",
        description: "字节跳动方舟平台，按推理接入点调用",
        accent: "rose",
        defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://www.volcengine.com/docs/82379",
        models: [],
    },
    {
        key: "ollama",
        name: "Ollama",
        description: "本地模型运行时，默认 11434 端口",
        accent: "slate",
        defaultBaseUrl: "http://127.0.0.1:11434/v1",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
        models: [],
    },
    {
        key: "lmstudio",
        name: "LM Studio",
        description: "本地推理服务器，默认 1234 端口",
        accent: "slate",
        defaultBaseUrl: "http://127.0.0.1:1234/v1",
        baseUrlRequired: false,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://lmstudio.ai/docs/app/api/endpoints/openai",
        models: [],
    },
    {
        key: "openai-compatible",
        name: "OpenAI 兼容（自定义）",
        description: "任意兼容 /v1/chat/completions 的端点，需自行填写 BaseUrl",
        accent: "amber",
        defaultBaseUrl: null,
        baseUrlRequired: true,
        sdk: "openai-compatible",
        kinds: ["LANGUAGE", "EMBEDDING"],
        listing: "openai",
        credentialFields: [],
        docUrl: "https://ai-sdk.dev/providers/openai-compatible-providers",
        models: [],
    },
]

const PROVIDER_BY_KEY = new Map(PROVIDER_CATALOG.map((provider) => [provider.key, provider]))

export function findProvider(key: string | null | undefined): ProviderDefinition | null {
    const value = String(key ?? "").trim()
    return value ? PROVIDER_BY_KEY.get(value) ?? null : null
}

export function requireProvider(key: string | null | undefined): ProviderDefinition {
    const provider = findProvider(key)
    if (!provider) {
        throw new Error(`未知的供应商：${key}`)
    }
    return provider
}

export function isProviderKey(key: unknown): key is string {
    return typeof key === "string" && PROVIDER_BY_KEY.has(key)
}

/**
 * 解析最终生效的 BaseUrl：用户填了就用用户的（去掉尾部斜杠），否则回落到默认值。
 * 返回 null 表示该供应商不需要 BaseUrl（如 Bedrock / Vertex 由 SDK 自行拼接）。
 */
export function resolveBaseUrl(provider: ProviderDefinition, override: string | null | undefined): string | null {
    const value = String(override ?? "").trim().replace(/\/+$/, "")
    if (value) return value
    return provider.defaultBaseUrl
}

/** 校验一个供应商实例的 BaseUrl 是否满足要求 */
export function validateBaseUrl(provider: ProviderDefinition, override: string | null | undefined): string | null {
    const resolved = resolveBaseUrl(provider, override)
    if (provider.baseUrlRequired && !resolved) {
        throw new Error(`${provider.name} 必须填写 BaseUrl`)
    }
    return resolved
}

/**
 * 该供应商可选的语言模型协议。未声明的供应商只有一套协议，
 * 由其官方 SDK 固定（多数是 chat completions，Anthropic/Gemini/Bedrock 则是各自的原生协议）。
 */
export function supportedApiProtocols(provider: ProviderDefinition): ApiProtocol[] {
    return provider.apiProtocols ?? ["chat"]
}

/**
 * 解析最终生效的协议：用户选了就用用户的（前提是该供应商支持），
 * 否则取目录里的第一项。绝不回落到 SDK 的隐式默认值。
 */
export function resolveApiProtocol(
    provider: ProviderDefinition,
    override: string | null | undefined,
): ApiProtocol {
    const supported = supportedApiProtocols(provider)
    const value = String(override ?? "").trim().toLowerCase()
    return supported.includes(value as ApiProtocol) ? value as ApiProtocol : supported[0]
}

/** 内置清单里该 kind 的模型 */
export function catalogModelsOf(provider: ProviderDefinition, kind?: ProviderModelKind): CatalogModel[] {
    return kind ? provider.models.filter((model) => model.kind === kind) : provider.models
}

/** 用模型 id 在内置清单里找元信息，用于补全上下文窗口和能力标记 */
export function findCatalogModel(provider: ProviderDefinition, modelId: string): CatalogModel | null {
    const value = modelId.trim()
    return provider.models.find((model) => model.id === value) ?? null
}

/**
 * 从模型 id 猜测它是语言模型还是向量模型。
 * 在线拉取的 /v1/models 通常不带类型信息，只能按命名约定判断。
 */
export function guessModelKind(modelId: string): ProviderModelKind {
    const value = modelId.toLowerCase()
    const embeddingHints = ["embed", "bge-", "gte-", "e5-", "m3e", "jina-clip", "text2vec"]
    return embeddingHints.some((hint) => value.includes(hint)) ? "EMBEDDING" : "LANGUAGE"
}

/**
 * 上下文窗口推断：内置清单优先，其次按模型名的家族特征兜底。
 * 只用于 UI 展示和上下文裁剪，不参与请求参数。
 */
export function guessContextWindow(modelId: string): number {
    const model = modelId.toLowerCase()
    if (model.includes("claude")) return 200_000
    if (model.includes("gemini-2") || model.includes("gemini-1.5-pro")) return 2_000_000
    if (model.includes("gemini")) return 1_000_000
    if (model.includes("deepseek-v4") || model.includes("deepseek-chat") || model.includes("deepseek-reasoner")) return 1_000_000
    if (model.includes("deepseek-r1") || model.includes("deepseek-v3")) return 64_000
    if (model.includes("deepseek")) return 128_000
    if (model.includes("qwen3.6") || model.includes("qwen-3.6")) return 1_000_000
    if (model.includes("qwen")) return 128_000
    if (model.includes("glm-5")) return 200_000
    if (model.includes("glm-4")) return 128_000
    if (model.includes("kimi") || model.includes("moonshot")) return 128_000
    if (model.includes("grok")) return 256_000
    if (model.includes("gpt-5") || model.includes("gpt-4.1")) return 400_000
    if (model.includes("gpt-4o") || model.includes("gpt-4-turbo") || model.startsWith("o1") || model.startsWith("o3")) return 128_000
    if (model.includes("gpt-3.5")) return 16_385
    return 128_000
}

/** 前端选择器用的精简视图 */
export function toCatalogSummary(provider: ProviderDefinition) {
    return {
        key: provider.key,
        name: provider.name,
        description: provider.description,
        accent: provider.accent,
        defaultBaseUrl: provider.defaultBaseUrl,
        baseUrlRequired: provider.baseUrlRequired,
        kinds: provider.kinds,
        apiProtocols: supportedApiProtocols(provider),
        supportsModelListing: provider.listing !== "none",
        credentialFields: provider.credentialFields,
        presetModels: provider.models,
        docUrl: provider.docUrl,
    }
}

export type ProviderCatalogSummary = ReturnType<typeof toCatalogSummary>

export function listCatalogSummaries(): ProviderCatalogSummary[] {
    return PROVIDER_CATALOG.map(toCatalogSummary)
}
