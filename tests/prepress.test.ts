import { describe, expect, it } from "vitest"

import {
  BLEED_CLEAR_PCT,
  BLEED_EDGE_PCT,
  INK_HIGH_PCT,
  INK_MEDIUM_PCT,
  inkRiskFromLoad,
  mediaSchema,
  pageResultSchema,
  ptToIn,
  ptToMm,
  pxToIn,
  pxToMm,
  verdictJsonSchema,
  verdictSchema,
  VINYL_STOCK,
} from "@/lib/prepress"

describe("unit conversion", () => {
  it("converts PostScript points", () => {
    expect(ptToMm(72)).toBeCloseTo(25.4, 5)
    expect(ptToIn(72)).toBe(1)
    expect(ptToMm(612)).toBeCloseTo(215.9, 1)
  })

  it("converts pixels at a known DPI", () => {
    expect(pxToIn(300, 300)).toBe(1)
    expect(pxToMm(150, 150)).toBeCloseTo(25.4, 5)
  })
})

describe("inkRiskFromLoad", () => {
  it("reads the page average", () => {
    expect(inkRiskFromLoad(0.9, 0)).toBe("low")
    expect(inkRiskFromLoad(INK_MEDIUM_PCT, 0)).toBe("medium")
    expect(inkRiskFromLoad(INK_HIGH_PCT, 0)).toBe("high")
  })

  it("escalates on a saturated tile even when the page average is low", () => {
    // A photo band covering a fraction of the page soaks locally first.
    expect(inkRiskFromLoad(3, 90)).toBe("high")
    expect(inkRiskFromLoad(3, 30)).toBe("medium")
  })

  it("keeps the documented thresholds in order", () => {
    expect(INK_MEDIUM_PCT).toBeLessThan(INK_HIGH_PCT)
    expect(BLEED_CLEAR_PCT).toBeLessThan(BLEED_EDGE_PCT)
  })
})

describe("verdictSchema", () => {
  const base = {
    documentType: "document",
    recommendedMedia: "70-80 GSM Bond",
    hasBleedMargins: false,
  }

  it("accepts a well-formed verdict", () => {
    expect(verdictSchema.safeParse(base).success).toBe(true)
  })

  it("rejects prose the model used to invent for the tray", () => {
    // Regression guard: free text let "desktop_inkjet_vinyl_cutting" through.
    expect(
      verdictSchema.safeParse({ ...base, recommendedMedia: "inkjet vinyl" })
        .success
    ).toBe(false)
    expect(
      verdictSchema.safeParse({ ...base, recommendedMedia: VINYL_STOCK })
        .success
    ).toBe(true)
  })

  it("rejects unknown document types", () => {
    expect(
      verdictSchema.safeParse({ ...base, documentType: "poster" }).success
    ).toBe(false)
  })

  it("has no inkRiskLevel: the band is measured, not authored", () => {
    // If this fails someone re-added the field and the gauge can disagree again.
    expect(
      verdictSchema.safeParse({ ...base, inkRiskLevel: "high" }).success
    ).toBe(false)
    expect(Object.keys(verdictSchema.shape)).toEqual([
      "documentType",
      "recommendedMedia",
      "hasBleedMargins",
    ])
  })

  it("exports every tray as a media value", () => {
    expect(mediaSchema.options).toContain(VINYL_STOCK)
  })
})

describe("grammar", () => {
  it("lists the enum values for the model's constrained decode", () => {
    const schema = verdictJsonSchema as {
      properties: { recommendedMedia: { enum: string[] } }
    }
    expect(schema.properties.recommendedMedia.enum).toEqual(mediaSchema.options)
  })
})

describe("pageResultSchema", () => {
  const page = {
    index: 1,
    page: {
      kind: "pdf",
      widthPt: 612,
      heightPt: 792,
      widthMm: 215.9,
      heightMm: 279.4,
      widthIn: 8.5,
      heightIn: 11,
      pageCount: 3,
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
    operatorNotes: "Load bond.",
    thumbnail: "data:image/png;base64,AA",
    lowDetail: true,
    thumbPx: 384,
    timingsMs: { raster: 1, pixels: 1, vision: 1, total: 3 },
    modelWarning: null,
  }

  it("accepts a page", () => {
    expect(pageResultSchema.safeParse(page).success).toBe(true)
  })

  it("rejects an unknown ink band", () => {
    expect(
      pageResultSchema.safeParse({ ...page, inkRiskLevel: "extreme" }).success
    ).toBe(false)
  })
})
