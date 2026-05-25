import { z } from "zod";
import { defineToolUiContract } from "../shared/contract";
import {
  ToolUIIdSchema,
  ToolUIReceiptSchema,
  ToolUIRoleSchema,
} from "../shared/schema";

export const CitationTypeSchema = z.enum([
  "webpage",
  "document",
  "article",
  "api",
  "code",
  "other",
]);

export type CitationType = z.infer<typeof CitationTypeSchema>;

export const CitationVariantSchema = z.enum(["default", "inline", "stacked"]);

export type CitationVariant = z.infer<typeof CitationVariantSchema>;

// 允许绝对 URL 或站内根路径 (/dashboard/...)
const CitationHrefSchema = z
  .string()
  .min(1)
  .refine((value) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
    try {
      const url = new URL(trimmed);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "href must be an http(s) URL or a root-relative path");

export const SerializableCitationSchema = z.object({
  id: ToolUIIdSchema,
  role: ToolUIRoleSchema.optional(),
  receipt: ToolUIReceiptSchema.optional(),
  href: CitationHrefSchema,
  title: z.string(),
  snippet: z.string().optional(),
  domain: z.string().optional(),
  favicon: z.string().url().optional(),
  author: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  type: CitationTypeSchema.optional(),
  locale: z.string().optional(),
});

export type SerializableCitation = z.infer<typeof SerializableCitationSchema>;

const SerializableCitationSchemaContract = defineToolUiContract(
  "Citation",
  SerializableCitationSchema,
);

export const parseSerializableCitation: (
  input: unknown,
) => SerializableCitation = SerializableCitationSchemaContract.parse;

export const safeParseSerializableCitation: (
  input: unknown,
) => SerializableCitation | null = SerializableCitationSchemaContract.safeParse;
