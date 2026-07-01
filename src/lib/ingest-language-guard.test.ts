import { describe, expect, it } from "vitest"
import {
  contentMatchesTargetLanguage,
  isCjkOutputLanguage,
  shouldRunContentLanguageGuard,
} from "./ingest-language-guard"

describe("ingest language guard", () => {
  it("treats Korean technical-English mode as a CJK target", () => {
    expect(isCjkOutputLanguage("KoreanTechnicalEnglish")).toBe(true)
    expect(isCjkOutputLanguage("English")).toBe(false)
  })

  it("accepts Korean prose with preserved English technical terms", () => {
    const content = [
      "---",
      "type: source",
      "title: Mixture of Experts",
      "---",
      "",
      "# Mixture of Experts",
      "",
      "MoE architecture에서 capacity factor는 expert가 처리할 수 있는 token 수를 제한하는 hyperparameter다.",
    ].join("\n")

    expect(contentMatchesTargetLanguage(content, "KoreanTechnicalEnglish")).toBe(true)
  })

  it("rejects source summaries that drift into a non-CJK language for Korean technical-English projects", () => {
    const content = [
      "---",
      "type: source",
      "title: A Visual Guide to Mixture of Experts",
      "---",
      "",
      "# A Visual Guide to Mixture of Experts",
      "",
      "Οπτικός εκπαιδευτικός οδηγός που εξηγεί το Mixture of Experts μέσω οπτικοποιήσεων.",
      "Πρόκειται για δευτερογενή πηγή σύνθεσης και όχι για πρωτότυπη έρευνα.",
    ].join("\n")

    expect(shouldRunContentLanguageGuard("wiki/sources/moe.md", "KoreanTechnicalEnglish")).toBe(true)
    expect(contentMatchesTargetLanguage(content, "KoreanTechnicalEnglish")).toBe(false)
  })

  it("keeps the existing source/entity exception for non-CJK targets", () => {
    expect(shouldRunContentLanguageGuard("wiki/sources/moe.md", "English")).toBe(false)
    expect(shouldRunContentLanguageGuard("wiki/entities/openai.md", "English")).toBe(false)
    expect(shouldRunContentLanguageGuard("wiki/concepts/routing.md", "English")).toBe(true)
  })
})
