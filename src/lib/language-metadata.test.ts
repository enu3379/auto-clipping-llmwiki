import { describe, expect, it } from "vitest"
import {
  getHtmlLang,
  getLanguagePromptName,
  getTextDirection,
  sameScriptFamily,
} from "./language-metadata"

describe("language metadata", () => {
  it("marks Persian as RTL Farsi for rendering and prompts", () => {
    expect(getLanguagePromptName("Persian")).toBe("Persian (Farsi / فارسی)")
    expect(getTextDirection("Persian")).toBe("rtl")
    expect(getHtmlLang("Persian")).toBe("fa")
  })

  it("keeps Persian and Arabic in the same script family", () => {
    expect(sameScriptFamily("Persian", "Arabic")).toBe(true)
  })

  it("treats Korean technical-English mode as Korean for rendering and script checks", () => {
    expect(getLanguagePromptName("KoreanTechnicalEnglish")).toBe("Korean with English technical terms")
    expect(getTextDirection("KoreanTechnicalEnglish")).toBe("ltr")
    expect(getHtmlLang("KoreanTechnicalEnglish")).toBe("ko")
    expect(sameScriptFamily("KoreanTechnicalEnglish", "Korean")).toBe(true)
  })

  it("defaults unknown languages to LTR with the original prompt name", () => {
    expect(getLanguagePromptName("Vietnamese")).toBe("Vietnamese")
    expect(getTextDirection("Vietnamese")).toBe("ltr")
  })
})
