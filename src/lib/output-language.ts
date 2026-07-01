import { useWikiStore } from "@/stores/wiki-store"
import { detectLanguage } from "./detect-language"
import { getLanguagePromptName } from "./language-metadata"

const KOREAN_TECHNICAL_ENGLISH = "KoreanTechnicalEnglish"

/**
 * Get the effective output language for LLM content generation.
 *
 * If user has explicitly set an outputLanguage, use it.
 * Otherwise (auto), fall back to detecting the language from the given text.
 */
export function getOutputLanguage(fallbackText: string = ""): string {
  const configured = useWikiStore.getState().outputLanguage
  if (configured && configured !== "auto") {
    return configured
  }
  return detectLanguage(fallbackText || "English")
}

/**
 * Build a strong language directive to inject into system prompts.
 */
export function buildLanguageDirective(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  if (lang === KOREAN_TECHNICAL_ENGLISH) {
    return [
      "## ⚠️ MANDATORY OUTPUT LANGUAGE: Korean with English technical terms",
      "",
      "Write explanations, summaries, section prose, and natural-language titles/headings in **Korean**.",
      "Preserve standard English technical terminology when that is the accepted form in ML, software, research, APIs, libraries, model names, dataset names, metrics, architecture names, and paper terminology.",
      "Do not machine-translate technical terms into rare Korean calques. Prefer the original English term, acronym, or code identifier when readers would naturally search for that form.",
      "When useful, explain a preserved English term in Korean around it, for example: `capacity factor는 expert가 처리할 수 있는 token 수를 제한하는 hyperparameter다`.",
      "Keep organization names, product names, model names, dataset names, tool/library names, acronyms, code identifiers, file names, URLs, paper titles, citation strings, and exact technical phrases in their standard original form.",
      "Use Korean particles and sentence structure naturally around English terms.",
      "The source material or wiki content may be in a different language; use it as evidence, but keep explanatory prose Korean-first with English technical terms preserved.",
      "This language rule overrides weaker style instructions, but it does not override the proper-noun and technical-identifier preservation rule above.",
    ].join("\n")
  }
  const promptLang = getLanguagePromptName(lang)
  return [
    `## ⚠️ MANDATORY OUTPUT LANGUAGE: ${promptLang}`,
    "",
    `Write surrounding natural-language prose in **${promptLang}**.`,
    `All generated prose, including prose titles and section headings, must be in ${promptLang}.`,
    `Do not translate, transliterate, or describe proper nouns and technical identifiers unless the source already uses a well-established localized form.`,
    `Preserve organization names, product names, model names, dataset names, tool/library names, acronyms, code identifiers, file names, URLs, paper titles, citation strings, and technical terms that have no widely-used localized equivalent in their standard original form.`,
    `The source material or wiki content may be in a different language; use it as evidence, but keep generated prose in ${promptLang}.`,
    `This language rule overrides weaker style instructions, but it does not override the proper-noun and technical-identifier preservation rule above.`,
  ].join("\n")
}

/**
 * Short reminder version — for placing right before user's current message.
 */
export function buildLanguageReminder(fallbackText: string = ""): string {
  const lang = getOutputLanguage(fallbackText)
  if (lang === KOREAN_TECHNICAL_ENGLISH) {
    return "REMINDER: Write explanatory prose in Korean; preserve standard English technical terms, acronyms, identifiers, URLs, file names, and paper titles in their original form."
  }
  return `REMINDER: Write prose in ${getLanguagePromptName(lang)}; preserve names, acronyms, identifiers, URLs, file names, and paper titles in their standard original form.`
}
