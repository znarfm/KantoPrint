import { describe, expect, it } from "vitest"

import {
  batchSummary,
  dominantMedia,
  inTray,
  isMixedMedia,
  trayBreakdown,
} from "@/lib/summary"
import type { JobResult, MediaStock, PageResult } from "@/lib/prepress"

function page(over: Partial<PageResult> = {}): PageResult {
  return {
    index: 1,
    page: {
      kind: "pdf",
      widthPt: 612,
      heightPt: 792,
      widthMm: 215.9,
      heightMm: 279.4,
      widthIn: 8.5,
      heightIn: 11,
      pageCount: 1,
      rasterDpi: 150,
    },
    pixels: {
      inkLoadPct: 1,
      darkAreaPct: 1,
      peakTileInkPct: 2,
      edgeInkPct: 0,
      saturation: 0,
      hasTransparency: false,
    },
    verdict: {
      documentType: "document",
      recommendedMedia: "70-80 GSM Bond",
      hasBleedMargins: false,
    },
    inkRiskLevel: "low",
    needsRotation: false,
    operatorNotes: "ok",
    thumbnail: "",
    lowDetail: true,
    thumbPx: 384,
    timingsMs: { raster: 0, pixels: 0, vision: 0, total: 0 },
    modelWarning: null,
    ...over,
  }
}

function job(
  name: string,
  pages: PageResult[],
  over: Partial<JobResult> = {}
): JobResult {
  return {
    fileName: name,
    byteSize: 100,
    mimeType: "application/pdf",
    pageCount: pages[0]?.page.pageCount ?? pages.length,
    pages,
    pagesSkipped: 0,
    timingsMs: { total: 0 },
    ...over,
  }
}

const BOND = "70-80 GSM Bond"
const CARD = "220+ GSM Matte Cardstock"

describe("dominantMedia", () => {
  it("uses the single page when there is one", () => {
    expect(dominantMedia(job("a.pdf", [page()]))).toBe(BOND)
  })

  it("takes the majority stock across pages", () => {
    const j = job("deck.pdf", [
      page({
        index: 1,
        verdict: { ...page().verdict, recommendedMedia: CARD },
      }),
      page({ index: 2 }),
      page({ index: 3 }),
    ])
    expect(dominantMedia(j)).toBe(BOND)
  })

  it("breaks a tie toward page 1, which leads the card", () => {
    const j = job("deck.pdf", [
      page({ index: 1 }),
      page({
        index: 2,
        verdict: { ...page().verdict, recommendedMedia: CARD },
      }),
    ])
    expect(dominantMedia(j)).toBe(BOND)
  })

  it("reports a mixed document", () => {
    expect(
      isMixedMedia(
        job("deck.pdf", [
          page({ index: 1 }),
          page({
            index: 2,
            verdict: { ...page().verdict, recommendedMedia: CARD },
          }),
        ])
      )
    ).toBe(true)
    expect(isMixedMedia(job("one.pdf", [page()]))).toBe(false)
  })
})

describe("trayBreakdown", () => {
  it("counts one job per file, not per page", () => {
    const trays = trayBreakdown([
      job("deck.pdf", [
        page({ index: 1 }),
        page({ index: 2 }),
        page({ index: 3 }),
      ]),
      job("form.pdf", [page()]),
    ])
    expect(trays).toEqual([{ stock: BOND, count: 2 }])
  })

  it("returns trays in stock order, not first-seen order", () => {
    const trays = trayBreakdown([
      job("b.pdf", [
        page({
          index: 1,
          verdict: {
            ...page().verdict,
            recommendedMedia: "300 GSM Photo Board",
          },
        }),
      ]),
      job("a.pdf", [page()]),
    ])
    expect(trays.map((t) => t.stock)).toEqual([BOND, "300 GSM Photo Board"])
  })
})

describe("inTray", () => {
  it("passes everything for the all tray", () => {
    expect(inTray(job("a.pdf", [page()]), "all")).toBe(true)
  })

  it("filters on the dominant stock", () => {
    expect(inTray(job("a.pdf", [page()]), BOND)).toBe(true)
    expect(inTray(job("a.pdf", [page()]), CARD)).toBe(false)
  })
})

describe("batchSummary", () => {
  it("is empty for no work", () => {
    expect(batchSummary([])).toBe("")
  })

  it("counts files and pages separately", () => {
    const text = batchSummary([
      job("deck.pdf", [page({ index: 1 }), page({ index: 2 })]),
    ])
    expect(text).toContain("1 file(s), 2 page(s)")
  })

  it("indexes flagged pages so p5 means page 5", () => {
    const text = batchSummary([
      job("deck.pdf", [
        page({ index: 1 }),
        page({ index: 2 }),
        page({
          index: 5,
          inkRiskLevel: "high",
          needsRotation: true,
          pixels: { ...page().pixels, inkLoadPct: 48 },
        }),
      ]),
    ])
    expect(text).toContain("p5 deck.pdf")
    expect(text).not.toContain("p2 deck.pdf")
  })

  it("omits the page index on a single-page job", () => {
    const text = batchSummary([
      job("form.pdf", [page({ inkRiskLevel: "high" })]),
    ])
    expect(text).toContain("form.pdf (heavy ink soak)")
    expect(text).not.toContain("p1 ")
  })

  it("marks a clean job rather than leaving it out", () => {
    const text = batchSummary([job("form.pdf", [page()])])
    expect(text).toContain("form.pdf  ok")
  })

  it("files every page under one tray block", () => {
    const text = batchSummary([
      job("a.pdf", [page()]),
      job("b.pdf", [
        page({
          index: 1,
          verdict: { ...page().verdict, recommendedMedia: CARD },
        }),
      ]),
    ])
    expect(text).toContain(`${BOND} x1`)
    expect(text).toContain(`${CARD} x1`)
  })
})

describe("stock values", () => {
  it("only ever emits values from the tray enum", () => {
    const known: MediaStock[] = [
      "70-80 GSM Bond",
      "Plain Recycled 100 GSM",
      "220+ GSM Matte Cardstock",
      "300 GSM Photo Board",
      "240 GSM Matte Photo",
      "240 GSM Glossy Photo",
      "Glossy Vinyl Sticker Sheet",
    ]
    const text = batchSummary([job("a.pdf", [page()])])
    for (const line of text.split("\n")) {
      if (line.includes(" x"))
        expect(known.some((k) => line.startsWith(k))).toBe(true)
    }
  })
})
