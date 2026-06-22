import type { NextConfig } from "next"
import withBundleAnalyzer from "@next/bundle-analyzer"
import nextConfig from "./next.config.js"

const bundleAnalyzer = withBundleAnalyzer({
    enabled: process.env.ANALYZE === "true",
})

export default bundleAnalyzer(nextConfig) as NextConfig
