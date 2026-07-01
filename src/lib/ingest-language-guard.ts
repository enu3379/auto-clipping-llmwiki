import { detectLanguage } from "@/lib/detect-language"
import { parseFrontmatter } from "@/lib/frontmatter"
import { sameScriptFamily } from "@/lib/language-metadata"
import { makeQuerySlug } from "@/lib/wiki-filename"

/**
 * Per-file language guard. Strips frontmatter + code/math blocks, runs
 * detectLanguage on the remainder, and returns whether the content is in
 * a language family compatible with the target. This catches cases where
 * the LLM follows the format spec but writes a single page in a wrong
 * language.
 */
export function contentMatchesTargetLanguage(content: string, target: string): boolean {
  const fmEnd = content.indexOf("\n---\n", 3)
  let body = fmEnd > 0 ? content.slice(fmEnd + 5) : content
  body = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$\n]*\$/g, "")
  const sample = body.slice(0, 1500)
  if (sample.trim().length < 20) return true

  const detected = detectLanguage(sample)

  const cjk = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean", "KoreanTechnicalEnglish"])
  const distinctNonLatin = new Set(["Arabic", "Persian", "Hindi", "Thai", "Hebrew"])
  const targetIsCjk = cjk.has(target)
  const detectedIsCjk = cjk.has(detected)
  if (targetIsCjk) return detectedIsCjk
  if (distinctNonLatin.has(target)) return detected === target
  if (distinctNonLatin.has(detected)) return sameScriptFamily(target, detected)
  return !detectedIsCjk
}

const CJK_OUTPUT_LANGUAGES = new Set(["Chinese", "Traditional Chinese", "Japanese", "Korean", "KoreanTechnicalEnglish"])

export function isCjkOutputLanguage(language: string | undefined): boolean {
  return Boolean(language && CJK_OUTPUT_LANGUAGES.has(language))
}

export function shouldRunContentLanguageGuard(
  relativePath: string,
  targetLang: string | undefined,
): boolean {
  if (!targetLang || targetLang === "auto") return false
  const path = relativePath.replace(/\\/g, "/")
  if (isLogPath(path) || isListingPath(path)) return false
  const isEntityOrSource =
    path.startsWith("wiki/entities/") ||
    path.includes("/entities/") ||
    path.startsWith("wiki/sources/") ||
    path.includes("/sources/")
  return !isEntityOrSource || isCjkOutputLanguage(targetLang)
}

function isLogPath(relativePath: string): boolean {
  return relativePath === "wiki/log.md" || relativePath.endsWith("/log.md")
}

function isListingPath(relativePath: string): boolean {
  return (
    relativePath === "wiki/index.md" ||
    relativePath.endsWith("/index.md") ||
    relativePath === "wiki/overview.md" ||
    relativePath.endsWith("/overview.md")
  )
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text)
}

function extractGeneratedPageTitle(content: string): string | null {
  const title = parseFrontmatter(content).frontmatter?.title
  if (typeof title === "string" && title.trim()) return title.trim()
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || null
}

export function rewriteIngestPathFromTitleForTargetLanguage(
  relativePath: string,
  content: string,
  targetLang: string | undefined,
): string {
  if (!targetLang || targetLang === "auto" || !CJK_OUTPUT_LANGUAGES.has(targetLang)) {
    return relativePath
  }
  if (
    isLogPath(relativePath) ||
    isListingPath(relativePath) ||
    relativePath.startsWith("wiki/sources/")
  ) {
    return relativePath
  }
  const title = extractGeneratedPageTitle(content)
  if (!title || !containsCjk(title)) return relativePath

  const slash = relativePath.lastIndexOf("/")
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : ""
  const fileName = slash >= 0 ? relativePath.slice(slash + 1) : relativePath
  if (containsCjk(fileName)) return relativePath

  const slug = makeQuerySlug(title)
  if (!containsCjk(slug)) return relativePath
  const nextPath = `${dir}${slug}.md`
  return isSafeGeneratedWikiPath(nextPath) ? nextPath : relativePath
}

function isSafeGeneratedWikiPath(path: string): boolean {
  if (typeof path !== "string" || path.trim().length === 0) return false
  if (/[\x00-\x1f]/.test(path)) return false
  if (path.startsWith("/") || path.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(path)) return false

  const normalized = path.replace(/\\/g, "/")
  const segments = normalized.split("/")
  if (segments.some((segment) => segment === "..")) return false
  if (segments.some((segment) => !isWindowsSafePathSegment(segment))) return false
  return normalized.startsWith("wiki/")
}

function isWindowsSafePathSegment(segment: string): boolean {
  if (segment.length === 0) return false
  if (/[<>:"|?*]/.test(segment)) return false
  if (/[ .]$/.test(segment)) return false
  const stem = segment.split(".")[0]?.toUpperCase()
  if (!stem) return false
  return !(
    stem === "CON" ||
    stem === "PRN" ||
    stem === "AUX" ||
    stem === "NUL" ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  )
}
