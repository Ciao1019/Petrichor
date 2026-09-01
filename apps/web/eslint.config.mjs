import js from "@eslint/js"
import jsxA11y from "eslint-plugin-jsx-a11y"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "coverage/**",
            "node_modules/**",
            "src/assets/**",
            // 以下目录以第三方生成代码为主，升级时保持上游形态。
            "src/components/ui/**",
            "src/components/extend/**",
            "src/components/assistant-ui/**",
            "src/components/tool-ui/**",
            "src/cuicui/**",
            "src/components/iconimate/glyphs.generated.ts",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    reactHooks.configs.flat.recommended,
    reactRefresh.configs.vite,
    {
        files: ["src/**/*.{ts,tsx}"],
        ...jsxA11y.flatConfigs.recommended,
        languageOptions: {
            ...jsxA11y.flatConfigs.recommended.languageOptions,
            globals: globals.browser,
        },
        rules: {
            ...jsxA11y.flatConfigs.recommended.rules,
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
                destructuredArrayIgnorePattern: "^_",
                varsIgnorePattern: "^_",
            }],
            // 项目未启用 React Compiler；这些规则约束编译器可优化性而非 Hook 正确性。
            "react-hooks/incompatible-library": "off",
            "react-hooks/immutability": "off",
            "react-hooks/preserve-manual-memoization": "off",
            "react-hooks/refs": "off",
            "react-hooks/set-state-in-effect": "off",
            "react-hooks/static-components": "off",
            // 现有模块有意共置 Context、Hook 与组件；Vite HMR 仍可工作，只是不保证局部保状态刷新。
            "react-refresh/only-export-components": "off",
        },
    },
    {
        files: ["scripts/**/*.{js,mjs,cjs,ts}", "*.{js,mjs,cjs,ts}", "vite.config.ts", "vitest.config.ts"],
        languageOptions: {
            globals: globals.node,
        },
    },
    {
        files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },
)
