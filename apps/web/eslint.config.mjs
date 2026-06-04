import js from "@eslint/js"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

export default tseslint.config(
    {
        ignores: [
            ".next/**",
            "node_modules/**",
            "drizzle/**",
            "src/assets/**",
            "src/components/**",
            "src/cuicui/**",
            "src/features/**",
            "src/hooks/**",
            "src/lib/**",
            "src/styles/**",
        ],
    },
    js.configs.recommended,
    ...nextVitals,
    ...nextTs,
    reactHooks.configs.flat.recommended,
)
