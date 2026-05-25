import { z } from "zod"

const publicEnvSchema = z.object({
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().trim().optional(),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
})

export interface PublicConfig {
    supabase: {
        anonKey: string | null
        url: string | null
    }
}

export function loadPublicConfigFromEnv(env: Record<string, string | undefined> = process.env): PublicConfig {
    const parsed = publicEnvSchema.parse(env)

    return {
        supabase: {
            anonKey: parsed.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
            url: parsed.NEXT_PUBLIC_SUPABASE_URL || null,
        },
    }
}
