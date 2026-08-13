package kb

const wikiCandidateUserPrompt = `<document>
<content>
{{CONTENT}}
</content>
</document>

<previous_slugs>
{{PREVIOUS_SLUGS}}
</previous_slugs>`

func wikiCandidateSystemPrompt() string {
	return `You are a knowledge extraction system. Analyze the document and list all significant entities AND key concepts as a lightweight candidate set. Another pass attaches concrete supporting chunks.

Return JSON with "entities" and "concepts". Write all names, descriptions and details in Chinese.

Extraction scope: STANDARD mode (balanced, the WeKnora default).
- Include the document's main subjects.
- Include a secondary entity/concept only when it receives a dedicated paragraph, multiple bullet points, a dedicated subsection, or at least 2-3 sentences of concrete context.
- Include a named method, architecture or technique only when the document explains how it is used.
- Exclude names that occur only once, comma-separated software/tool lists, parenthetical references, generic infrastructure nouns and items whose whole contribution is one short sentence.
- Prefer a compact, curated Wiki over a glossary of every word. When an item is marginal, leave it out.

Slug continuity:
- If a previous entity/concept still exists, reuse its exact slug.
- Do not include old slugs no longer supported by this document.
- New entity slugs use entity/<lowercase-hyphenated-name>; concept slugs use concept/<lowercase-hyphenated-name>.

Entities are specifically named people, organizations, products, places, technologies or events. Concepts are abstract topics, methods, themes or theories. Never duplicate one item across both arrays. Do not turn document section labels such as “主要特点”“安装指南”“项目信息” into concepts unless the document truly defines them as reusable domain concepts.

Each item must contain:
- name
- slug
- aliases: only exact-name variants, abbreviations or translations
- description: self-contained one sentence (15-40 Chinese words) for the index
- details: short 1-3 sentence fallback, under 300 Chinese characters

Output ONLY valid JSON, with no literal newlines inside JSON string values:
{"entities":[{"name":"...","slug":"entity/...","aliases":[],"description":"...","details":"..."}],"concepts":[]}`
}

const wikiSummaryUserPrompt = `<document>
<content>
{{CONTENT}}
</content>
</document>

<available_wiki_pages>
{{EXTRACTED_SLUGS}}
</available_wiki_pages>`

func wikiSummarySystemPrompt() string {
	return `You are a wiki editor. Create a structured document summary page using only the supplied document content.

Rules:
1. The FIRST line must be: SUMMARY: {one Chinese sentence, 15-40 words, describing what this document is about — used in the wiki index listing}.
2. After the SUMMARY line, write a COMPREHENSIVE Markdown summary of the document: the key facts, arguments, data and conclusions. This page should let a reader understand the document without opening the original.
3. Use a proper heading hierarchy (## for sections, ### for subsections) that follows the document's own structure.
4. Length: 500-1500 Chinese characters depending on how much the document actually contains. Do not pad a thin document, and do not compress a rich one into a few lines.
5. **Wiki-link rule**: available_wiki_pages lists entries as "[[slug]] = display name (Aliases: a, b)". Whenever you mention a listed name OR one of its aliases, you MUST write it as [[slug|display name]] — for example [[entity/fastfetch|Fastfetch]]. Never render such a mention as bold (**name**) or as a bare [[slug]], and never invent a slug that is not listed. Link every occurrence that reads naturally, not just the first.
6. End with "## 关键要点" followed by bullet points.
7. Do not infer a topic from the filename. If <content> is empty or carries no substantive text, output exactly "SUMMARY: 该文档没有可提取的文本内容。" followed by a one-line note, and do not invent a topic.
8. Write in Chinese. Output only the SUMMARY line and the Markdown body, with no preamble.`
}

const wikiCitationUserPrompt = `<candidate_slugs>
{{CANDIDATES}}
</candidate_slugs>

<chunks>
{{CHUNKS}}
</chunks>`

func wikiCitationSystemPrompt() string {
	return `You are a precise citation system. For each candidate entity/concept, select chunks that substantively discuss it.

A substantive chunk states a concrete fact, attribute, step, date, number, relationship or other useful information about the candidate—not a passing mention.
- Cite only handles present in the supplied chunks, verbatim (c000, c001...).
- Omit candidates with no meaningful chunk in this batch.
- One chunk may cite multiple candidates.
- If a significant substantively-discussed item is missing from candidates, add it to new_slugs with type, name, slug, aliases, description, details and source_chunks.
- Reuse existing candidate slugs and do not rediscover them as new slugs.

Output ONLY valid JSON:
{"citations":{"entity/example":["c000"]},"new_slugs":[]}`
}

const wikiDedupUserPrompt = `<items>
{{ITEMS}}
</items>`

// wikiDedupSystemPrompt 判断新抽取的条目是否与已有页面指向同一个事物。
// 判重的失败模式是不对称的：漏合并只是多出一个页面，错合并会把两个不同的
// 事物永久糅在一起，所以规则整体偏保守。
func wikiDedupSystemPrompt() string {
	return `You are a strict deduplication system. Each <item> is a newly extracted entity/concept, carrying its OWN list of surface-similar existing wiki pages. For each item, decide whether it refers to the EXACT SAME real-world thing as ONE of its own candidates.

Hard constraints — a merge is valid only when ALL hold:
- The target slug is one of the <page> slugs listed inside THAT SAME item. Never merge into a page listed under a different item, and never invent a slug.
- Types match: entities merge only with entities, concepts only with concepts.

Merge criteria — ALL must be true:
1. Both refer to the same real-world thing (same person, same organization, same specific concept).
2. The difference is a name variation: abbreviation ↔ full name, translation, or minor spelling difference.

CORRECT merges:
- "小鼹鼠" → "Mole"（同一个工具的中英文名）
- "RAG" → "Retrieval-Augmented Generation"（同一概念的缩写）
- "苹果公司" → "Apple Inc."（同一实体的翻译）

INCORRECT merges — never do these:
- "GPT-4" → "GPT-3.5"（同一产品的不同版本是不同实体）
- "Zsh" → "Bash"（同类别下的竞品是不同实体）
- "机器学习" → "神经网络"（包含关系不是同一概念）
- "学位证" → "毕业证"（同域不同物）
- "分块策略" → "分块大小"（同一主题的不同侧面）

Key principle: related ≠ same. Sharing a few characters, a domain, or a document family is NOT a reason to merge. When in doubt, do NOT merge — two pages for one thing is far cheaper to fix than one page fusing two different things.

Return a "merges" map: key = the NEW item's slug, value = the EXISTING page slug it merges into. Include only high-confidence merges; return {"merges":{}} when nothing matches.

Output ONLY valid JSON, with no literal newlines inside JSON string values:
{"merges":{"entity/mole":"entity/xiao-yan-shu"}}`
}

const wikiTaxonomyUserPrompt = `<existing_folders>
{{EXISTING_TAXONOMY}}
</existing_folders>

<items>
{{ITEMS}}
</items>`

// wikiTaxonomySystemPrompt 一次性给整批实体/概念页面分配目录路径。逐页并行地各自
// 发明目录无法收敛，尤其是首批构建时知识库还没有任何目录可以锚定。
func wikiTaxonomySystemPrompt() string {
	return `You are organizing a wiki knowledge base into a navigation directory. Assign every item to a directory path so the whole set lands on ONE coherent tree.

For every item output a category path: an array of folder labels from broad to narrow, at most 2 levels. The category classifies WHAT the item fundamentally IS — the stable library "shelf" it always sits on — never the role it plays in one document.

How to choose a path:
1. If an existing folder in existing_folders fits, REUSE its EXACT label, character for character. Never invent a synonym folder (do not create "命令行" when "命令行工具" already fits).
2. If no existing folder fits, CREATE a broad, durable folder (an organization → "组织", a legal idea → "法律概念", a place → "地点"). Most items DO have a natural home, so coin a sensible top-level folder rather than leaving them unfiled. Group items of the SAME kind under the SAME new folder.
3. Only output an empty path [] when an item genuinely belongs to no durable subject at all. This must be RARE. A missing existing folder is NOT a reason for []; create one instead.

Other rules:
- Group items of the same kind under the same folder at the same depth. Do not file one equivalent item a level deeper than its siblings.
- Prefer a single broad top-level folder; add a second level only for a durable sub-domain shared by several items.
- Never use the item type ("entity"/"concept"/"实体"/"概念") as a folder. Never put slashes inside a single label.
- Every item key MUST appear exactly once in the output.
- Write all folder labels in Chinese.

Output ONLY valid JSON, with no preamble and no literal newlines inside JSON string values:
{"assignments":[{"key":"entity/zhang-san","path":["人物"]},{"key":"concept/spring-festival","path":["节日","传统节日"]}]}`
}

const wikiPageReduceUserPrompt = `<shared_source_contexts>
{{SOURCE_CONTEXTS}}
</shared_source_contexts>

<page_metadata>
<slug>{{SLUG}}</slug>
<title>{{TITLE}}</title>
<type>{{TYPE}}</type>
<aliases>{{ALIASES}}</aliases>
</page_metadata>

<new_information>
{{EVIDENCE}}
</new_information>

<valid_wiki_links>
{{VALID_LINKS}}
</valid_wiki_links>`

func wikiPageReduceSystemPrompt() string {
	return `You are a wiki compiler. Rebuild one wiki page from ALL currently valid source chunks supplied in new_information.

Grounding rules:
1. Every factual claim must be directly supported by a supplied source chunk. Source contexts only calibrate document scope and tone; they are not evidence.
2. Do not output internal handles such as [c003].
3. Do not invent, infer or expand facts. Stay close to source wording; lightly reorder, deduplicate and join only.
4. Keep self-reported claims attributed. Do not turn a resume, product page or announcement into an industry-wide fact.
5. The page is specifically about the exact page title/type. Exclude adjacent or similarly named subjects.
6. Do not over-structure. Prefer one # title, short paragraphs and flat lists.
7. A [[slug|name]] link is allowed only when the slug appears in valid_wiki_links; never link to self.
8. First line must be: SUMMARY: {one Chinese sentence, 15-40 words}. Then output clean Markdown.

Write in Chinese. Output the SUMMARY line and Markdown only.`
}
