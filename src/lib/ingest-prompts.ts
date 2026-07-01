import { computeContextBudget } from "@/lib/context-budget"
import { buildLanguageDirective } from "@/lib/output-language"
import { GENERATION_WIKI_TYPES } from "@/lib/wiki-page-types"

/**
 * Build the language rule for ingest prompts.
 * Uses the user's configured output language, falling back to source content detection.
 */
export function languageRule(sourceContent: string = ""): string {
  return buildLanguageDirective(sourceContent)
}

function currentWikiDate(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function trimLongText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n\n[...trimmed for prompt budget...]`
}

function aggregateRepairSectionCap(maxContextSize: number | undefined): number {
  const { maxCtx } = computeContextBudget(maxContextSize)
  return Math.max(4_000, Math.floor(maxCtx * 0.12))
}

/**
 * Step 1 prompt: AI reads the source and produces a structured analysis.
 * This is the "discussion" step - the AI reasons about the source before writing wiki pages.
 */
export function buildAnalysisPrompt(
  purpose: string,
  index: string,
  sourceContent: string = "",
  schema: string = "",
): string {
  return [
    "You are an expert research analyst. Read the source document and produce a structured analysis.",
    "Do not output chain-of-thought, hidden reasoning, or a thinking transcript. Reason internally and write only the concise final analysis.",
    "",
    languageRule(sourceContent),
    "",
    "Your analysis should cover:",
    "",
    "## Key Entities",
    "List people, organizations, products, datasets, tools mentioned. For each:",
    "- Name and type",
    "- Role in the source (central vs. peripheral)",
    "- Whether it likely already exists in the wiki (check the index)",
    "",
    "## Key Concepts",
    "List theories, methods, techniques, phenomena. For each:",
    "- Name and brief definition",
    "- Why it matters in this source",
    "- Whether it likely already exists in the wiki",
    "",
    "## Main Arguments & Findings",
    "- What are the core claims or results?",
    "- What evidence supports them?",
    "- How strong is the evidence?",
    "- Which named subject is each claim about? Do not transfer claims, limits, or evaluations from one entity/model/product/method to another just because they share keywords.",
    "",
    "## Connections to Existing Wiki",
    "- What existing pages does this source relate to?",
    "- Does it strengthen, challenge, or extend existing knowledge?",
    "",
    "## Contradictions & Tensions",
    "- Does anything in this source conflict with existing wiki content?",
    "- Are there internal tensions or caveats?",
    "",
    "## Recommendations",
    "- What wiki pages should be created or updated?",
    "- If the project schema (below) defines page types beyond entity/concept (e.g. goal, habit, reflection, finding, decision, meeting), and the source genuinely contains matching content, recommend pages of those types - name the type explicitly. Only when the source actually supports it; never invent goals/habits/journal entries that aren't in the source.",
    "- What should be emphasized vs. de-emphasized?",
    "- Any open questions worth flagging for the user?",
    "",
    "Be thorough but concise. Focus on what's genuinely important.",
    "",
    "If a folder context is provided, use it as a hint for categorization - the folder structure often reflects the user's organizational intent (e.g., 'papers/energy' suggests the file is an energy-related paper).",
    "",
    schema
      ? `## Project Schema (page types available - map source content to schema-defined types when it fits)\n${schema}`
      : "",
    purpose ? `## Wiki Purpose (for context)\n${purpose}` : "",
    index ? `## Current Wiki Index (for checking existing content)\n${index}` : "",
  ].filter(Boolean).join("\n")
}

/**
 * Step 2 prompt: AI takes its own analysis and generates wiki files + review items.
 */
export function buildGenerationPrompt(
  schema: string,
  purpose: string,
  index: string,
  sourceFileName: string,
  overview?: string,
  sourceContent: string = "",
  sourceSummaryPath?: string,
): string {
  // Use original filename (without extension) as the source summary page name
  const sourceBaseName = sourceFileName.replace(/\.[^.]+$/, "")
  const summaryPath = sourceSummaryPath ?? `wiki/sources/${sourceBaseName}.md`
  const today = currentWikiDate()

  return [
    "You are a wiki maintainer. Based on the analysis provided, generate wiki files.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble. Reason internally and output only the requested FILE/REVIEW blocks.",
    "",
    languageRule(sourceContent),
    "",
    `## IMPORTANT: Source File`,
    `The original source file is: **${sourceFileName}**`,
    `All wiki pages generated from this source MUST include this filename in their frontmatter \`sources\` field.`,
    `Today's date is **${today}**. Use this exact date for all new \`created\`, \`updated\`, and wiki/log.md ingest dates.`,
    "",
    schema
      ? [
          "## Project Schema and Routing (AUTHORITATIVE)",
          schema,
          "",
          "Use this schema as the primary routing rule for page types and directories.",
          "If it defines custom folders or distinctions (for example people, technologies, organizations, methods, or cases), write pages into those schema-defined folders instead of forcing them into wiki/entities/ or wiki/concepts/.",
          "Use wiki/entities/ and wiki/concepts/ only when the schema does not provide a more specific destination.",
          "Every generated page's frontmatter type must match the schema directory used in its FILE path.",
        ].join("\n")
      : "",
    "",
    "## What to generate",
    "",
    `1. A source summary page at **${summaryPath}** (MUST use this exact path)`,
    "2. Entity or schema-defined typed pages for key named things identified in the analysis. Prefer schema-defined directories when present; otherwise use wiki/entities/.",
    "3. Concept or schema-defined typed pages for key ideas, methods, techniques, and abstractions. Prefer schema-defined directories when present; otherwise use wiki/concepts/.",
    "4. An updated wiki/index.md - add new entries to existing categories, preserve all existing entries",
    "5. A log entry for wiki/log.md (just the new entry to append, format: ## [YYYY-MM-DD] ingest | Title)",
    "6. An updated wiki/overview.md - a high-level summary of what the entire wiki covers, updated to reflect the newly ingested source. This should be a comprehensive 2-5 paragraph overview of ALL topics in the wiki, not just the new source.",
    "",
    "## Frontmatter Rules (CRITICAL - parser is strict)",
    "",
    "Every page begins with a YAML frontmatter block. Format rules, in order of importance:",
    "",
    "1. The VERY FIRST line of the file MUST be exactly `---` (three hyphens, nothing else).",
    "   Do NOT wrap the file in a ```yaml ... ``` code fence.",
    "   Do NOT prefix it with a `frontmatter:` key or any other line.",
    "2. Each frontmatter line is a `key: value` pair on its own line.",
    "3. The frontmatter ends with another `---` line on its own.",
    "4. The next line after the closing `---` is the start of the page body.",
    "5. Arrays use the standard YAML inline form `[a, b, c]` (no outer brackets around each item).",
    "   Wikilinks belong in the BODY only - never write `related: [[a]], [[b]]` (invalid YAML);",
    "   write `related: [a, b]` with bare slugs.",
    "",
    "Required fields and types:",
    `  • type     - one of the known types (${GENERATION_WIKI_TYPES.join(" | ")}), or a custom type explicitly defined by the project schema`,
    "  • title    - string (quote it if it contains a colon, e.g. `title: \"Foo: Bar\"`)",
    `  • created  - ${today} for new pages (YYYY-MM-DD, no quotes)`,
    `  • updated  - ${today} for new pages (same as created)`,
    "  • tags     - array of bare strings: `tags: [microbiology, ai]`",
    "  • related  - array of bare wiki page slugs: `related: [foo, bar-baz]`. Do NOT include",
    "               `wiki/`, `.md`, or `[[…]]` here - slugs only.",
    `  • sources  - array of source filenames; MUST include "${sourceFileName}".`,
    "",
    "Concrete example of a complete, parseable page (everything between the two `---` lines",
    "is the frontmatter; the heading and prose below are the body):",
    "",
    "    ---",
    "    type: entity",
    "    title: Example Entity",
    `    created: ${today}`,
    `    updated: ${today}`,
    "    tags: [example, demo]",
    "    related: [related-slug-1, related-slug-2]",
    `    sources: ["${sourceFileName}"]`,
    "    ---",
    "",
    "    # Example Entity",
    "",
    "    Body content goes here. Use [[wikilink]] syntax in the body for cross-references.",
    "",
    "Other rules:",
    "- Use [[wikilink]] syntax in the BODY for cross-references between pages",
    "- If you include images, use wiki-root-relative paths such as `media/source-slug/image.png`; never output absolute filesystem paths.",
    "- Preserve subject boundaries: when a source discusses multiple entities/models/products/methods, keep claims, evaluations, limitations, benchmark results, and recommendations attached to the exact subject they describe.",
    "- Do not merge or generalize a claim about one subject into another subject's page solely because they share terms (for example context window size, benchmark name, dataset name, architecture, or feature name).",
    "- If a page needs to mention another subject for comparison, write it explicitly as a comparison and cite which source/frontmatter `sources` entry supports that statement.",
    "- Use kebab-case filenames",
    "- Derive filenames from the page title in the mandatory output language, but short proper nouns and technical identifiers take precedence: preserve names such as OpenAI, GPT-5, Transformer, CLIP, ImageNet, PyTorch, CUDA, GitHub, arXiv, React, LanceDB, AnyTXT, MinerU, model names, dataset names, tool names, and code identifiers in their standard original form. Do not put raw URLs, citation strings, or full paper titles directly into file paths; convert surrounding descriptive prose to a safe readable title. For Chinese/Japanese/Korean prose titles, keep readable CJK characters in the filename instead of translating the slug to English.",
    "- Follow the analysis recommendations on what to emphasize",
    "- If the analysis found connections to existing pages, add cross-references",
    "",
    "## Review block types",
    "",
    "After all FILE blocks, optionally emit REVIEW blocks for anything that needs human judgment:",
    "",
    "- contradiction: the analysis found conflicts with existing wiki content",
    "- duplicate: an entity/concept might already exist under a different name in the index",
    "- missing-page: an important concept is referenced but has no dedicated page",
    "- suggestion: ideas for further research, related sources to look for, or connections worth exploring",
    "",
    "Only create reviews for things that genuinely need human input. Don't create trivial reviews.",
    "",
    "## OPTIONS allowed values (only these predefined labels):",
    "",
    "- contradiction: OPTIONS: Create Page | Skip",
    "- duplicate: OPTIONS: Create Page | Skip",
    "- missing-page: OPTIONS: Create Page | Skip",
    "- suggestion: OPTIONS: Create Page | Skip",
    "",
    "The user also has a 'Deep Research' button (auto-added by the system) that triggers web search.",
    "Do NOT invent custom option labels. Only use 'Create Page' and 'Skip'.",
    "",
    "For suggestion and missing-page reviews, the SEARCH field must contain 2-3 web search queries",
    "(keyword-rich, specific, suitable for a search engine - NOT titles or sentences). Example:",
    "  SEARCH: automated technical debt detection AI generated code | software quality metrics LLM code generation | static analysis tools agentic software development",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index (preserve all existing entries, add new ones)\n${index}` : "",
    overview ? `## Current Overview (update this to reflect the new source)\n${overview}` : "",
    "",
    // Output format must remain the last section because models weight recent instructions highest.
    "## Output Format (MUST FOLLOW EXACTLY - this is how the parser reads your response)",
    "",
    "Your ENTIRE response consists of FILE blocks followed by optional REVIEW blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path/to/page.md---",
    "(complete file content with YAML frontmatter)",
    "---END FILE---",
    "```",
    "",
    "REVIEW block template (optional, after all FILE blocks):",
    "```",
    "---REVIEW: type | Title---",
    "Description of what needs the user's attention.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "## Output Requirements (STRICT - deviations will cause parse failure)",
    "",
    "1. The FIRST character of your response MUST be `-` (the opening of `---FILE:`).",
    "2. DO NOT output any preamble such as \"Here are the files:\", \"Based on the analysis...\", or any introductory prose.",
    "3. DO NOT echo or restate the analysis - that was stage 1's job. Your job is to emit FILE blocks.",
    "4. DO NOT output markdown tables, bullet lists, or headings outside of FILE/REVIEW blocks.",
    "5. DO NOT output any trailing commentary after the last `---END FILE---` or `---END REVIEW---`.",
    "6. Between blocks, use only blank lines - no prose.",
    "7. FILE block prose (body, explanations, descriptions, section text) must use the mandatory output language specified below. Preserve proper nouns, acronyms, model names, dataset names, tool/library names, code identifiers, URLs, file names, citation strings, paper titles, and technical terms with no widely-used localized equivalent in their standard original form, including in page names and section headings.",
    "",
    "If you start with anything other than `---FILE:`, the entire response will be discarded.",
    "",
    // Repeat the language directive at the very end so it wins the "most
    // recent instruction" tie-breaker. Small-to-medium models otherwise
    // drift back to their training-data language for individual pages.
    "---",
    "",
    languageRule(sourceContent),
  ].filter(Boolean).join("\n")
}

export function buildReviewSuggestionPrompt(
  purpose: string,
  index: string,
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const { maxCtx } = computeContextBudget(maxContextSize)
  const sectionCap = Math.max(4_000, Math.floor(maxCtx * 0.15))
  const indexCap = Math.max(3_000, Math.floor(sectionCap * 0.8))
  return [
    "You are identifying high-value follow-up research items for a personal wiki.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Your job is NOT to generate wiki pages. The wiki page generation already happened.",
    "Output only REVIEW blocks for unresolved knowledge gaps that deserve human attention or Deep Research.",
    "",
    "Create REVIEW blocks only for genuinely useful follow-up work:",
    "- missing-page: an important entity/concept is referenced but still lacks a dedicated page",
    "- suggestion: a research question, source type, or comparison that would materially improve the wiki",
    "- contradiction: a conflict or tension that requires user judgment",
    "- duplicate: likely duplicate pages/names that need user review",
    "",
    "Prefer 1-5 high-signal reviews. If there is nothing worth reviewing, output nothing.",
    "For suggestion and missing-page reviews, include a SEARCH line with 2-3 keyword-rich web search queries separated by ` | `.",
    "Use only these options: OPTIONS: Create Page | Skip",
    "",
    "REVIEW block template:",
    "```",
    "---REVIEW: suggestion | Precise title---",
    "Concise description of the gap and why it matters.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/page1.md, wiki/page2.md",
    "SEARCH: query 1 | query 2 | query 3",
    "---END REVIEW---",
    "```",
    "",
    "Return REVIEW blocks only. Do not output FILE blocks. Do not wrap the response in markdown fences.",
    "",
    purpose ? `## Wiki Purpose\n${purpose}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, indexCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## Generated Wiki Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

export function buildAggregateRepairPrompt(
  paths: string[],
  purpose: string,
  index: string,
  overview: string,
  sourceIdentity: string,
  analysis: string,
  sourceContext: string,
  generation: string,
  maxContextSize: number | undefined,
): string {
  const sectionCap = aggregateRepairSectionCap(maxContextSize)
  const today = currentWikiDate()
  return [
    "You are repairing aggregate wiki files after an ingest generation.",
    "Do not output chain-of-thought, hidden reasoning, or explanatory preamble.",
    "",
    languageRule(sourceContext),
    "",
    "Generate ONLY the requested aggregate FILE blocks listed below.",
    "Do not generate entity, concept, source summary, query, comparison, or synthesis pages.",
    "",
    "Requested paths:",
    ...paths.map((path) => `- ${path}`),
    "",
    "Rules:",
    `- Use today's date ${today} for log entries and frontmatter dates.`,
    "- For wiki/index.md: output the complete updated index, preserving existing entries and adding the new source-derived entries.",
    "- For wiki/overview.md: output the complete updated overview, reflecting the full wiki plus this new source.",
    "- For wiki/log.md: output only the new log entry to append, format `## [YYYY-MM-DD] ingest | Title`.",
    "- Output only FILE blocks. Nothing else.",
    "",
    "FILE block template:",
    "```",
    "---FILE: wiki/path.md---",
    "(complete file content, or just the new log entry for wiki/log.md)",
    "---END FILE---",
    "```",
    "",
    purpose ? `## Wiki Purpose\n${trimLongText(purpose, Math.floor(sectionCap * 0.5))}` : "",
    index ? `## Current Wiki Index\n${trimLongText(index, sectionCap)}` : "",
    overview ? `## Current Overview\n${trimLongText(overview, sectionCap)}` : "",
    "",
    `## Source\n${sourceIdentity}`,
    "",
    "## Stage 1 Analysis",
    trimLongText(analysis, sectionCap),
    "",
    "## Source Context",
    trimLongText(sourceContext, sectionCap),
    "",
    "## First Generation Output",
    trimLongText(generation, sectionCap),
  ].filter(Boolean).join("\n")
}

export function buildPageMergeSystemPrompt(): string {
  return [
    "You are merging two versions of the same wiki page into one coherent document.",
    "Both versions target the same wiki page; one is already on disk,",
    "the other was just generated from a different source document.",
    "Either version may mention additional subjects for comparison or context.",
    "",
    "Output ONE merged version that:",
    "- Preserves every factual claim from both versions (do not drop content)",
    "- Eliminates redundancy when both versions state the same fact",
    "- Preserves subject/source boundaries: if either version mentions other entities/models/products/methods for comparison, keep those comparisons attribution-exact and do not fold them into claims about the main page subject",
    "- When claims conflict or apply to different subjects, keep them separated and say which source version supports each one instead of synthesizing a single generalized conclusion",
    "- When in doubt whether two similar-looking claims describe the same fact, prefer keeping them separate",
    "- Reorganizes sections so the structure is logical for the merged topic,",
    "  not just a concatenation of the two inputs",
    "- Uses consistent markdown structure (headings, tables, lists, callouts)",
    "- Keeps `[[wikilink]]` references intact",
    "",
    "Output requirements:",
    "- The FIRST character of your response MUST be `-` (the opening of `---`)",
    "- Output the COMPLETE file: YAML frontmatter + body",
    "- No preamble (no \"Here is the merged version:\"), no analysis prose",
    "- The caller will overwrite `sources`/`tags`/`related`/`updated` with",
    "  deterministic values - your job is the body and any other fields",
  ].join("\n")
}
