"use client"

import dynamic from "next/dynamic"

const App = dynamic(() => import("@/client-app"), {
    ssr: false,
})

export function SpaEntry() {
    return <App />
}
