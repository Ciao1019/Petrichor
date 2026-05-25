import { randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import bcrypt from "bcryptjs"
import { getDb } from "@/server/db/client"
import { betterAuthAccounts, betterAuthUsers, users } from "@/server/db/schema"
import type { BetterAuthUserRecord, UserRecord } from "@/server/db/schema"
import { badRequest, unauthorized } from "@/server/http/response"
import { resolveRegisterDefaultSystemRole } from "./register-policy"

export interface BetterAuthUserLike {
    id: string
    email: string
    name?: string | null
    image?: string | null
    createdAt?: Date | string | null
    updatedAt?: Date | string | null
}

export function normalizeAuthEmail(email: string) {
    return email.trim().toLowerCase()
}

function resolveDisplayName(user: Pick<BetterAuthUserLike, "email" | "name">) {
    const name = user.name?.trim()
    if (name) {
        return name
    }
    return normalizeAuthEmail(user.email).split("@")[0] || normalizeAuthEmail(user.email)
}

function authUserIdForLegacyUser(user: Pick<UserRecord, "id" | "authUserId">) {
    return user.authUserId?.trim() || `petrichor_${user.id}`
}

export async function findPetrichorUserByAuthUserId(authUserId: string) {
    const [user] = await getDb()
        .select()
        .from(users)
        .where(eq(users.authUserId, authUserId))
        .limit(1)
    return user ?? null
}

export async function findPetrichorUserByEmail(email: string) {
    const normalizedEmail = normalizeAuthEmail(email)
    const [user] = await getDb()
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizedEmail}`)
        .limit(1)
    return user ?? null
}

export async function ensurePetrichorUserForBetterAuthUser(
    authUser: BetterAuthUserLike,
    options: {
        systemRole?: "USER" | "SUPER_ADMIN"
        userType?: string
        passwordHash?: string
    } = {},
) {
    const db = getDb()
    const normalizedEmail = normalizeAuthEmail(authUser.email)
    const displayName = resolveDisplayName(authUser)
    const existingByAuthId = await findPetrichorUserByAuthUserId(authUser.id)
    if (existingByAuthId) {
        return existingByAuthId
    }

    const existingByEmail = await findPetrichorUserByEmail(normalizedEmail)
    if (existingByEmail) {
        const [user] = await db
            .update(users)
            .set({
                authUserId: authUser.id,
                avatar: existingByEmail.avatar || authUser.image || null,
                updatedAt: new Date(),
            })
            .where(eq(users.id, existingByEmail.id))
            .returning()
        return user
    }

    const [user] = await db
        .insert(users)
        .values({
            authUserId: authUser.id,
            email: normalizedEmail,
            passwordHash: options.passwordHash ?? "",
            systemRole: options.systemRole ?? resolveRegisterDefaultSystemRole(),
            userType: options.userType ?? "LOCAL",
            username: displayName,
            nickname: displayName,
            avatar: authUser.image ?? null,
        })
        .returning()
    return user
}

export async function ensureBetterAuthCredentialsForEmail(email: string) {
    const normalizedEmail = normalizeAuthEmail(email)
    const petrichorUser = await findPetrichorUserByEmail(normalizedEmail)
    if (!petrichorUser?.passwordHash.trim()) {
        return null
    }

    const db = getDb()
    const authUserId = authUserIdForLegacyUser(petrichorUser)
    const name = petrichorUser.nickname?.trim() || petrichorUser.username?.trim() || normalizedEmail

    await db
        .insert(betterAuthUsers)
        .values({
            id: authUserId,
            name,
            email: normalizedEmail,
            emailVerified: true,
            image: petrichorUser.avatar,
            createdAt: petrichorUser.createdAt,
            updatedAt: petrichorUser.updatedAt,
        })
        .onConflictDoNothing({ target: betterAuthUsers.email })

    const [authUser] = await db
        .select()
        .from(betterAuthUsers)
        .where(sql`lower(${betterAuthUsers.email}) = ${normalizedEmail}`)
        .limit(1)

    if (!authUser) {
        return null
    }

    if (petrichorUser.authUserId !== authUser.id) {
        await db
            .update(users)
            .set({ authUserId: authUser.id, updatedAt: new Date() })
            .where(eq(users.id, petrichorUser.id))
    }

    const [account] = await db
        .select()
        .from(betterAuthAccounts)
        .where(and(
            eq(betterAuthAccounts.providerId, "credential"),
            eq(betterAuthAccounts.accountId, authUser.id),
        ))
        .limit(1)

    if (!account) {
        await db.insert(betterAuthAccounts).values({
            id: `credential_${petrichorUser.id}`,
            accountId: authUser.id,
            providerId: "credential",
            userId: authUser.id,
            password: petrichorUser.passwordHash,
            createdAt: petrichorUser.createdAt,
            updatedAt: petrichorUser.updatedAt,
        }).onConflictDoNothing({ target: [betterAuthAccounts.providerId, betterAuthAccounts.accountId] })
        return authUser
    }

    if (!account.password?.trim()) {
        await db
            .update(betterAuthAccounts)
            .set({ password: petrichorUser.passwordHash, updatedAt: new Date() })
            .where(eq(betterAuthAccounts.id, account.id))
    }

    return authUser
}

export async function createLocalUserWithBetterAuth(input: {
    email: string
    password: string
    name: string
    systemRole: "USER" | "SUPER_ADMIN"
}) {
    const normalizedEmail = normalizeAuthEmail(input.email)
    const existingUser = await findPetrichorUserByEmail(normalizedEmail)
    if (existingUser) {
        throw badRequest("邮箱已被注册")
    }

    const db = getDb()
    const existingAuthUser = await db
        .select({ id: betterAuthUsers.id })
        .from(betterAuthUsers)
        .where(sql`lower(${betterAuthUsers.email}) = ${normalizedEmail}`)
        .limit(1)

    if (existingAuthUser.length > 0) {
        throw badRequest("邮箱已被注册")
    }

    const authUserId = randomUUID()
    const passwordHash = await bcrypt.hash(input.password, 10)
    const username = normalizedEmail.split("@")[0]?.trim() || input.name

    const [user] = await db.transaction(async (tx) => {
        await tx.insert(betterAuthUsers).values({
            id: authUserId,
            name: input.name,
            email: normalizedEmail,
            emailVerified: true,
            image: null,
        })
        await tx.insert(betterAuthAccounts).values({
            id: randomUUID(),
            accountId: authUserId,
            providerId: "credential",
            userId: authUserId,
            password: passwordHash,
        })
        return await tx.insert(users).values({
            authUserId,
            email: normalizedEmail,
            passwordHash,
            systemRole: input.systemRole,
            userType: "LOCAL",
            username: username || null,
            nickname: input.name || null,
            avatar: null,
            signature: null,
        }).returning()
    })

    return user
}

export async function deleteBetterAuthUserForPetrichorUser(user: Pick<UserRecord, "authUserId">) {
    const authUserId = user.authUserId?.trim()
    if (!authUserId) {
        return
    }
    await getDb().delete(betterAuthUsers).where(eq(betterAuthUsers.id, authUserId))
}

export async function getCredentialPasswordHash(authUserId: string) {
    const [account] = await getDb()
        .select({ password: betterAuthAccounts.password })
        .from(betterAuthAccounts)
        .where(and(
            eq(betterAuthAccounts.userId, authUserId),
            eq(betterAuthAccounts.providerId, "credential"),
        ))
        .limit(1)
    return account?.password ?? null
}

export async function syncPetrichorPasswordHashFromBetterAuth(user: Pick<UserRecord, "id" | "authUserId">) {
    const authUserId = user.authUserId?.trim()
    if (!authUserId) {
        return
    }
    const passwordHash = await getCredentialPasswordHash(authUserId)
    if (!passwordHash?.trim()) {
        return
    }
    await getDb()
        .update(users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(users.id, user.id))
}

export async function requireAuthUserIdForPetrichorUser(user: Pick<UserRecord, "authUserId" | "email">) {
    const authUserId = user.authUserId?.trim()
    if (authUserId) {
        return authUserId
    }
    await ensureBetterAuthCredentialsForEmail(user.email)
    const linked = await findPetrichorUserByEmail(user.email)
    if (!linked?.authUserId) {
        throw unauthorized("登录信息已失效")
    }
    return linked.authUserId
}

export function toBetterAuthUserLike(user: BetterAuthUserRecord): BetterAuthUserLike {
    return {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    }
}
