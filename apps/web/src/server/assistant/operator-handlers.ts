import type { NextRequest } from "next/server"
import { z } from "zod"
import { requireCurrentUser } from "@/server/auth/current-user"
import { ok, readJson, toErrorResponse } from "@/server/http/response"
import { assistantIdSchema } from "./thread-logic"
import { listSkillPendings, resolveSkillPending } from "./operator-skills"
import {
    listEvolutionProposals,
    resolveEvolutionProposal,
    runEvolutionProposal,
} from "./operator-evolution"

const pendingResolveSchema = z.object({
    pendingId: assistantIdSchema,
    decision: z.enum(["approve", "reject"]),
})

const evolutionRunSchema = z.object({
    targetType: z.enum(["skill", "user_profile", "agent_notes"]),
    targetName: z.string().trim().min(1).max(64).optional().nullable(),
    hint: z.string().trim().max(500).optional().nullable(),
})

const evolutionListSchema = z.object({
    status: z.enum(["pending", "accepted", "rejected"]).optional(),
})

const evolutionResolveSchema = z.object({
    proposalId: assistantIdSchema,
    decision: z.enum(["accept", "reject"]),
})

export async function operatorSkillsPendingList(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        return ok({ items: await listSkillPendings({ id: user.id, systemRole: user.systemRole }) })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function operatorSkillsPendingResolve(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = pendingResolveSchema.parse(await readJson(request))
        return ok(await resolveSkillPending(
            { id: user.id, systemRole: user.systemRole },
            input.pendingId,
            input.decision,
        ))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function operatorEvolutionRun(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = evolutionRunSchema.parse(await readJson(request))
        return ok(await runEvolutionProposal({
            user: { id: user.id, systemRole: user.systemRole },
            targetType: input.targetType,
            targetName: input.targetName,
            hint: input.hint,
        }))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function operatorEvolutionList(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = evolutionListSchema.parse(await readJson(request).catch(() => ({})))
        return ok({
            items: await listEvolutionProposals(
                { id: user.id, systemRole: user.systemRole },
                input.status,
            ),
        })
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}

export async function operatorEvolutionResolve(request: NextRequest) {
    try {
        const user = await requireCurrentUser(request)
        const input = evolutionResolveSchema.parse(await readJson(request))
        return ok(await resolveEvolutionProposal(
            { id: user.id, systemRole: user.systemRole },
            input.proposalId,
            input.decision,
        ))
    } catch (error) {
        return toErrorResponse(error, request.nextUrl.pathname)
    }
}
