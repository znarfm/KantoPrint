import { describe, expect, it } from "vitest"

import { jobFlags, operatorBrief, type FlagInput } from "@/lib/flags"
import type { PixelStats, Verdict } from "@/lib/prepress"

const pixels = (over: Partial<PixelStats> = {}): PixelStats => ({
  inkLoadPct: 1,
  darkAreaPct: 1,
  peakTileInkPct: 2,
  edgeInkPct: 0,
  saturation: 0,
  hasTransparency: false,
  ...over,
})

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  documentType: "document",
  recommendedMedia: "70-80 GSM Bond",
  hasBleedMargins: false,
  ...over,
})

const input = (over: Partial<FlagInput> = {}): FlagInput => ({
  verdict: verdict(),
  pixels: pixels(),
  needsRotation: false,
  inkRiskLevel: "low",
  ...over,
})

const ids = (f: FlagInput) => jobFlags(f).map((x) => x.id)

describe("jobFlags", () => {
  it("is empty for a clean job", () => {
    expect(ids(input())).toEqual([])
  })

  it("warns about ink at the measured band, not a model guess", () => {
    // The band arrives on the input, so a gauge reading and a flag can never
    // disagree the way they did when the model authored the band.
    expect(ids(input({ inkRiskLevel: "medium" }))).toContain("ink-wet")
    expect(ids(input({ inkRiskLevel: "high" }))).toContain("ink-soak")
    expect(ids(input({ inkRiskLevel: "low" }))).not.toContain("ink-wet")
  })

  it("gives vinyl a different instruction because vinyl does not curl", () => {
    const onPaper = jobFlags(input({ inkRiskLevel: "high" }))
    const onVinyl = jobFlags(
      input({
        inkRiskLevel: "high",
        verdict: verdict({
          documentType: "sticker",
          recommendedMedia: "Glossy Vinyl Sticker Sheet",
        }),
      })
    )
    expect(onPaper[0].instruction).toContain("curl")
    expect(onVinyl[0].instruction).not.toContain("curl")
    expect(onVinyl[0].instruction).toContain("matte side up")
  })

  it("distinguishes artwork at the trim from ink at the trim", () => {
    expect(
      ids(input({ verdict: verdict({ hasBleedMargins: true }) })).some((i) =>
        i.startsWith("trim-")
      )
    ).toBe(true)
    expect(
      ids(
        input({
          verdict: verdict({ hasBleedMargins: true }),
          pixels: pixels({ hasTransparency: true }),
        })
      )
    ).toContain("trim-artwork")
  })

  it("flags rotation only when the page needs it", () => {
    expect(ids(input({ needsRotation: true }))).toContain("rotate")
    expect(ids(input({ needsRotation: false }))).not.toContain("rotate")
  })

  it("asks for a kerf test on a die-cut job", () => {
    expect(
      ids(input({ verdict: verdict({ documentType: "sticker" }) }))
    ).toContain("kerf")
  })

  it("asks for a visual check when the job type is unreadable", () => {
    expect(
      ids(input({ verdict: verdict({ documentType: "unknown" }) }))
    ).toContain("unreadable")
  })

  it("orders the worst news first", () => {
    const all = ids(
      input({
        inkRiskLevel: "high",
        needsRotation: true,
        verdict: verdict({ hasBleedMargins: true }),
      })
    )
    expect(all.indexOf("ink-soak")).toBeLessThan(all.indexOf("trim-ink"))
    expect(all.indexOf("trim-ink")).toBeLessThan(all.indexOf("rotate"))
  })
})

describe("operatorBrief", () => {
  it("falls back to the load line when nothing fired", () => {
    const i = input()
    expect(operatorBrief(i.verdict.recommendedMedia, jobFlags(i))).toBe(
      "Load 70-80 GSM Bond and print at 100% scale."
    )
  })

  it("joins every fired instruction into one sentence chain", () => {
    const i = input({
      inkRiskLevel: "high",
      needsRotation: true,
      verdict: verdict({ hasBleedMargins: true }),
    })
    const brief = operatorBrief(i.verdict.recommendedMedia, jobFlags(i))
    expect(brief.split("; ")).toHaveLength(3)
    expect(brief.endsWith(".")).toBe(true)
  })

  it("quotes the measured ink load so the number matches the gauge", () => {
    const i = input({
      inkRiskLevel: "high",
      pixels: pixels({ inkLoadPct: 47.9 }),
    })
    expect(operatorBrief(i.verdict.recommendedMedia, jobFlags(i))).toContain(
      "47.9%"
    )
  })
})
