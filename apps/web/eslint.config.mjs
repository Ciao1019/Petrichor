import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
    {
        ignores: [
            "dist/**",
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
    ...tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    {
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
                destructuredArrayIgnorePattern: "^_",
                varsIgnorePattern: "^_",
            }],
        },
    },
    {
        files: ["scripts/**/*.{js,mjs,cjs,ts}"],
        languageOptions: {
            globals: globals.node,
        },
    },
)
