import { describe, expect, it } from "vitest"

import { reconcile } from "@/lib/preflight"
import { analyzePixels } from "@/lib/pixels"
import sharp from "sharp"
import { BLEED_CLEAR_PCT, BLEED_EDGE_PCT, VINYL_STOCK } from "@/lib/prepress"
import type { PixelStats, Verdict } from "@/lib/prepress"

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  documentType: "document",
  recommendedMedia: "70-80 GSM Bond",
  hasBleedMargins: false,
  ...over,
})

const pixels = (over: Partial<PixelStats> = {}): PixelStats => ({
  inkLoadPct: 1,
  darkAreaPct: 1,
  peakTileInkPct: 2,
  edgeInkPct: 0,
  saturation: 0,
  hasTransparency: false,
  ...over,
})

describe("reconcile", () => {
  it("believes the pixels over the model on bleed", () => {
    // The model called a blank-margin contract bleeding and a full-bleed
    // invitation safe. Both cases are pinned by measurement.
    expect(
      reconcile(verdict({ hasBleedMargins: true }), pixels()).hasBleedMargins
    ).toBe(false)
    expect(
      reconcile(
        verdict({ hasBleedMargins: false }),
        pixels({ edgeInkPct: BLEED_EDGE_PCT })
      ).hasBleedMargins
    ).toBe(true)
  })

  it("keeps the model where the pixels are ambiguous", () => {
    // Between clear and bleeding, the model's read is the tie-breaker.
    const edge = (BLEED_EDGE_PCT + BLEED_CLEAR_PCT) / 2
    expect(
      reconcile(
        verdict({ hasBleedMargins: true }),
        pixels({ edgeInkPct: edge })
      ).hasBleedMargins
    ).toBe(true)
    expect(
      reconcile(
        verdict({ hasBleedMargins: false }),
        pixels({ edgeInkPct: edge })
      ).hasBleedMargins
    ).toBe(false)
  })

  it("pins a sticker to vinyl and vinyl to a sticker", () => {
    const asSticker = reconcile(
      verdict({ documentType: "sticker", recommendedMedia: "70-80 GSM Bond" }),
      pixels()
    )
    expect(asSticker.recommendedMedia).toBe(VINYL_STOCK)

    // Alpha plus a vinyl choice means a die-cut job, whatever the model called it.
    const asUnknown = reconcile(
      verdict({ documentType: "unknown", recommendedMedia: VINYL_STOCK }),
      pixels({ hasTransparency: true })
    )
    expect(asUnknown.documentType).toBe("sticker")

    // Without alpha, a vinyl choice is not enough to claim a sticker.
    const opaque = reconcile(
      verdict({ documentType: "unknown", recommendedMedia: VINYL_STOCK }),
      pixels({ hasTransparency: false })
    )
    expect(opaque.documentType).toBe("unknown")
  })

  it("never invents a field the model did not send", () => {
    expect(Object.keys(reconcile(verdict(), pixels())).sort()).toEqual([
      "documentType",
      "hasBleedMargins",
      "recommendedMedia",
    ])
  })
})

describe("analyzePixels", () => {
  const white = (size = 200) =>
    sharp({
      create: { width: size, height: size, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer()

  it("reads an empty page as no ink", async () => {
    const s = await analyzePixels(await white())
    expect(s.inkLoadPct).toBe(0)
    expect(s.darkAreaPct).toBe(0)
    expect(s.edgeInkPct).toBe(0)
    expect(s.saturation).toBe(0)
    expect(s.hasTransparency).toBe(false)
  })

  it("reads a solid black page as full coverage", async () => {
    const buf = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "#000" },
    })
      .png()
      .toBuffer()
    const s = await analyzePixels(buf)
    expect(s.inkLoadPct).toBe(100)
    expect(s.darkAreaPct).toBe(100)
    // Solid ink reaches the trim on every side.
    expect(s.edgeInkPct).toBe(100)
    expect(s.peakTileInkPct).toBe(100)
  })

  it("counts a known coverage band", async () => {
    // Left half black, right half white.
    const buf = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "#fff" },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 100,
              height: 200,
              channels: 3,
              background: "#000",
            },
          })
            .png()
            .toBuffer(),
          left: 0,
          top: 0,
        },
      ])
      .png()
      .toBuffer()
    const s = await analyzePixels(buf)
    expect(s.inkLoadPct).toBeCloseTo(50, 0)
    // The black half spans the full height, so it fills the left edge band
    // completely and the white half fills the right one: the edge average
    // lands on the page average rather than above or below it.
    expect(s.edgeInkPct).toBeCloseTo(s.inkLoadPct, 0)
  })

  it("reports saturation for colour and not for greys", async () => {
    const colour = await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer()
    const grey = await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer()

    expect((await analyzePixels(colour)).saturation).toBe(1)
    expect((await analyzePixels(grey)).saturation).toBe(0)
  })

  it("flags alpha so a cut path is not counted as ink", async () => {
    // Fully transparent PNG: flattened to paper, so no ink, but alpha present.
    const buf = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer()
    const s = await analyzePixels(buf)
    expect(s.hasTransparency).toBe(true)
    expect(s.inkLoadPct).toBe(0)
  })
})
