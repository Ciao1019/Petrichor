import type { NextRequest } from "next/server"
import { wikiEmbeddingRun } from "@/server/kb/wiki-agent-handlers"

export const maxDuration = 300

export function POST(request: NextRequest) {
    return wikiEmbeddingRun(request)
}
