import { describe, expect, it } from "vitest"

import { inkProfile } from "@/lib/judge"
import { MAX_PAGES, RASTER_DPI, THUMB_PX, THUMB_PX_DETAIL } from "@/lib/raster"
import { MAX_BYTES } from "@/lib/preflight"
import sharp from "sharp"

/** Builds a PDF with n pages so the raster path can be exercised. */
async function pdf(pages: number) {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) doc.addPage([360, 504])
  return Buffer.from(await doc.save())
}

describe("inkProfile", () => {
  const base = {
    inkLoadPct: 1,
    darkAreaPct: 1,
    saturation: 0,
    hasTransparency: false,
  }

  it("calls sparse monochrome text a document", () => {
    // The whole reason this exists: at 384px an 11pt line is unreadable, so the
    // model is told the shape of the job instead of being asked to guess.
    expect(inkProfile(base)).toContain("document")
  })

  it("reads alpha as a die-cut job", () => {
    expect(inkProfile({ ...base, hasTransparency: true })).toContain("sticker")
  })

  it("distinguishes heavy colour from heavy greyscale", () => {
    expect(inkProfile({ ...base, inkLoadPct: 30, saturation: 0.5 })).toContain(
      "colour"
    )
    expect(
      inkProfile({ ...base, inkLoadPct: 30, saturation: 0 })
    ).not.toContain("colour")
  })

  it("falls back to a mixed profile rather than guessing a job", () => {
    expect(inkProfile({ ...base, inkLoadPct: 12 })).toBe(
      "mid-weight mixed content"
    )
  })
})

describe("limits", () => {
  it("caps pages so a long PDF cannot run unbounded", () => {
    expect(MAX_PAGES).toBeGreaterThan(0)
    expect(MAX_PAGES).toBeLessThanOrEqual(100)
  })

  it("caps upload size", () => {
    expect(MAX_BYTES).toBeGreaterThan(0)
  })

  it("keeps the default thumbnail below the detail size", () => {
    // 256px was measured to break classification; detail mode is the opt-in.
    expect(THUMB_PX).toBeGreaterThanOrEqual(384)
    expect(THUMB_PX_DETAIL).toBeGreaterThan(THUMB_PX)
  })

  it("rasterises at a DPI that resolves the edge band", () => {
    expect(RASTER_DPI).toBeGreaterThanOrEqual(150)
  })
})

describe("ingest guards", () => {
  it("rejects content that only claims to be an image", async () => {
    const { ingest } = await import("@/lib/preflight")
    const bogus = new File([Buffer.from("not a pdf at all")], "x.pdf", {
      type: "application/pdf",
    })
    await expect(ingest(bogus)).rejects.toThrow(/only PDF, PNG and JPEG/)
  })

  it("rejects an empty file", async () => {
    const { ingest } = await import("@/lib/preflight")
    const empty = new File([], "x.png", { type: "image/png" })
    await expect(ingest(empty)).rejects.toThrow(/empty/)
  })

  it("sniffs a real PDF even when the declared type is wrong", async () => {
    const { ingest } = await import("@/lib/preflight")
    const real = new File([await pdf(1)], "x.bin", {
      type: "application/octet-stream",
    })
    expect((await ingest(real)).mimeType).toBe("application/pdf")
  })

  it("sniffs a real PNG even when the declared type is wrong", async () => {
    const { ingest } = await import("@/lib/preflight")
    const buf = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer()
    const real = new File([buf], "x.bin", { type: "application/octet-stream" })
    expect((await ingest(real)).mimeType).toBe("image/png")
  })
})
