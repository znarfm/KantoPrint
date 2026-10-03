import { z } from "zod"

/** What the print job actually is. Drives media + ink expectations. */
export const documentTypeSchema = z.enum([
  "sticker",
  "invitation",
  "photo",
  "document",
  "unknown",
])

export const inkRiskSchema = z.enum(["low", "medium", "high"])

/**
 * Tray stock. An enum rather than prose: a 2B model invents "inkjet vinyl" if
 * you let it write the label, and the operator needs a tray key to sort by.
 * Order is the tray order in the export bar.
 */
export const VINYL_STOCK = "Glossy Vinyl Sticker Sheet"

export const MEDIA_STOCKS = [
  "70-80 GSM Bond",
  "Plain Recycled 100 GSM",
  "220+ GSM Matte Cardstock",
  "300 GSM Photo Board",
  "240 GSM Matte Photo",
  "240 GSM Glossy Photo",
  VINYL_STOCK,
] as const

export const mediaSchema = z.enum(MEDIA_STOCKS)
export type MediaStock = z.infer<typeof mediaSchema>

/**
 * Model contract. Single source of truth: `z.toJSONSchema(verdictSchema)` is
 * handed to Ollama as the `format` grammar, then the raw text is parsed back
 * through the same schema. Nothing model-authored reaches the UI unvalidated.
 */
export const verdictSchema = z.object({
  documentType: documentTypeSchema,
  recommendedMedia: mediaSchema.describe(
    "Tray stock that suits this job type first, ink load second."
  ),
  hasBleedMargins: z
    .boolean()
    .describe(
      "True when ink or a cut line touches the trim edge (standard bleed is 3 mm / 0.125 in)."
    ),
  inkRiskLevel: inkRiskSchema,
})

/** Deterministic pixel metrics. Model never authors these. */
export const pixelStatsSchema = z.object({
  /** Mean ink coverage across the page, 0-100. */
  inkLoadPct: z.number(),
  /** Share of the page at >=50% coverage, 0-100. */
  darkAreaPct: z.number(),
  /** Worst 64px tile mean coverage, 0-100. Catches local soak (photo bands, solids). */
  peakTileInkPct: z.number(),
  /** Mean coverage inside the outer 3 mm band, 0-100. Bleed proxy. */
  edgeInkPct: z.number(),
  /** Colour saturation mean, 0-1. Near 0 means monochrome. */
  saturation: z.number(),
  /** Alpha below 255 in the source (sticker cut paths). */
  hasTransparency: z.boolean(),
})

export const pageInfoSchema = z.object({
  kind: z.enum(["pdf", "image"]),
  /** PostScript points for PDF, pixels for images. */
  widthPt: z.number(),
  heightPt: z.number(),
  widthMm: z.number(),
  heightMm: z.number(),
  widthIn: z.number(),
  heightIn: z.number(),
  pageCount: z.number(),
  /** DPI the page was rasterised at before downscaling. */
  rasterDpi: z.number(),
  pagesAnalyzed: z.number().nullable(),
})

export const jobResultSchema = z.object({
  fileName: z.string(),
  byteSize: z.number(),
  mimeType: z.string(),
  page: pageInfoSchema,
  pixels: pixelStatsSchema,
  verdict: verdictSchema,
  /** Portrait media feed, so a landscape page should turn. Geometry, not guesswork. */
  needsRotation: z.boolean(),
  /** Composed from the flags and the gauge, not model prose. See preflight.ts. */
  operatorNotes: z.string(),
  /** data: URL of the 512px thumbnail handed to the vision model. */
  thumbnail: z.string(),
  timingsMs: z.object({
    raster: z.number(),
    pixels: z.number(),
    vision: z.number(),
    total: z.number(),
  }),
  /** Set when Gemma returned JSON that failed validation and the retry did not land. */
  modelWarning: z.string().nullable(),
})

export type DocumentType = z.infer<typeof documentTypeSchema>
export type InkRiskLevel = z.infer<typeof inkRiskSchema>
export type Verdict = z.infer<typeof verdictSchema>
export type PixelStats = z.infer<typeof pixelStatsSchema>
export type PageInfo = z.infer<typeof pageInfoSchema>
export type JobResult = z.infer<typeof jobResultSchema>

/** Grammar for Ollama's structured output. */
export const verdictJsonSchema = z.toJSONSchema(verdictSchema, {
  io: "output",
}) as Record<string, unknown>

/** Ink load thresholds used by both the gauge and the risk reconciliation. */
export const INK_HIGH_PCT = 22
export const INK_MEDIUM_PCT = 10

/** Edge band ink above this counts as artwork touching the trim. */
export const BLEED_EDGE_PCT = 5
/** Below this the edge band is provably blank, whatever the model says. */
export const BLEED_CLEAR_PCT = 0.5

export function inkRiskFromLoad(
  inkLoadPct: number,
  peakTileInkPct: number
): InkRiskLevel {
  // A saturated tile soaks locally long before the page average looks alarming.
  const load = Math.max(inkLoadPct, peakTileInkPct * 0.6)
  if (load >= INK_HIGH_PCT) return "high"
  if (load >= INK_MEDIUM_PCT) return "medium"
  return "low"
}

/** mm from PostScript points. */
export const ptToMm = (pt: number) => (pt * 25.4) / 72
export const ptToIn = (pt: number) => pt / 72
/** Pixels to inches at a known DPI. */
export const pxToIn = (px: number, dpi: number) => px / dpi
export const pxToMm = (px: number, dpi: number) => (px / dpi) * 25.4
