import type { AppRequest } from "@/server/http/request"
import { wikiEmbeddingRun } from "@/server/kb/wiki-agent-handlers"

export const maxDuration = 300

export function POST(request: AppRequest) {
    return wikiEmbeddingRun(request)
}
