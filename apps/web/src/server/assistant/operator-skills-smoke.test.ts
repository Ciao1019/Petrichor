import { describe, expect, it } from "vitest"
import { applyOperatorMemoryMutation } from "./operator-memory"
import { OPERATOR_MEMORY_PROMPT_TITLE, formatOperatorMemoryPromptSection } from "./operator-memory"

// smoke for episodic merge helpers via re-export shape
describe("operator episodic helpers exist", () => {
    it("memory format title locked", () => {
        expect(formatOperatorMemoryPromptSection({
            userProfileMd: "a",
            agentNotesMd: "b",
            frozenAt: "t",
        })).toContain(OPERATOR_MEMORY_PROMPT_TITLE)
    })

    it("patch mutation still works alongside new stack", () => {
        const result = applyOperatorMemoryMutation("hello", "", {
            action: "replace",
            target: "user_profile",
            old_text: "hello",
            new_text: "world",
        })
        expect(result).toEqual({ ok: true, userProfileMd: "world", agentNotesMd: "" })
    })
})
