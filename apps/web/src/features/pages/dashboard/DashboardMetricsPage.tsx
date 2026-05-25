import { ParticleTextDots } from "@/components/particle-text-dots"

export function DashboardMetricsPage() {
    return (
        <div className="flex flex-1 items-center justify-center p-4 md:p-6">
            <ParticleTextDots
                text="Petrichor"
                className="h-[260px] w-full max-w-[980px] sm:h-[320px] md:h-[380px]"
            />
        </div>
    )
}
