import { analyzePixels } from "./pixels"
import {
  BLEED_CLEAR_PCT,
  BLEED_EDGE_PCT,
  MEDIA_STOCKS,
  VINYL_STOCK,
  inkRiskFromLoad,
  type JobResult,
  type PixelStats,
  type Verdict,
} from "./prepress"
import { jobFlags, operatorBrief } from "./flags"
import { judgeVerdict, inkProfile } from "./judge"
import { prepareRaster } from "./raster"

export const ACCEPTED = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
} as const

export const MAX_BYTES = 25 * 1024 * 1024

export type Ingest = {
  fileName: string
  byteSize: number
  mimeType: string
  buffer: Buffer
}

/** `%PDF-` */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]
/** PNG signature, then IHDR. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The browser-supplied MIME lies often enough to matter. Sniff magic bytes and
 * only fall back to the declared type when the head is unrecognisable.
 */
export async function ingest(file: File): Promise<Ingest> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const head = buffer.subarray(0, 12)
  const startsWith = (sig: number[]) => sig.every((b, i) => head[i] === b)

  let mimeType: keyof typeof ACCEPTED | null = null
  if (startsWith(PDF)) mimeType = "application/pdf"
  else if (startsWith(PNG)) mimeType = "image/png"
  else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    mimeType = "image/jpeg"
  else if (file.type in ACCEPTED) mimeType = file.type as keyof typeof ACCEPTED

  if (!mimeType) {
    throw new Error(`${file.name}: only PDF, PNG and JPEG are accepted.`)
  }
  if (buffer.byteLength === 0) throw new Error(`${file.name}: empty file.`)
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(
      `${file.name}: ${mb(buffer.byteLength)} exceeds the ${mb(MAX_BYTES)} cap.`
    )
  }

  return { fileName: file.name, byteSize: buffer.byteLength, mimeType, buffer }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Step A -> D. Raster + measure deterministically, then let Gemma judge, then
 * reconcile: if the model reports a calmer ink risk than the pixels support,
 * the measurement wins.
 */
export async function runPreflight(args: {
  fileName: string
  byteSize: number
  mimeType: string
  buffer: Buffer
}): Promise<JobResult> {
  const t0 = performance.now()
  const { page, raster, thumbnail, cleanup } = await prepareRaster(
    args.buffer,
    args.mimeType
  )
  const tRaster = performance.now()

  const pixels = await analyzePixels(raster)
  const tPixels = performance.now()

  let verdict: Verdict
  let modelWarning: string | null
  const landscape = page.widthPt > page.heightPt
  try {
    const judged = await judgeVerdict({
      thumbnail,
      kind: page.kind,
      pageCount: page.pageCount,
      sizeLabel: `${page.widthMm} x ${page.heightMm} mm`,
      orientation: landscape ? "landscape" : "portrait",
      inkLoad: pixels.inkLoadPct,
      darkArea: pixels.darkAreaPct,
      peakTile: pixels.peakTileInkPct,
      edgeInk: pixels.edgeInkPct,
      transparent: pixels.hasTransparency,
      profile: inkProfile(pixels),
    })
    verdict = judged.verdict
    modelWarning = judged.warning
  } catch (err) {
    // Ollama down, or the model missed the contract twice. The operator still
    // gets the measured half of the job instead of a blank card.
    verdict = {
      documentType: "unknown",
      recommendedMedia: MEDIA_STOCKS[0],
      hasBleedMargins: pixels.edgeInkPct >= BLEED_EDGE_PCT,
      inkRiskLevel: inkRiskFromLoad(pixels.inkLoadPct, pixels.peakTileInkPct),
    }
    modelWarning = err instanceof Error ? err.message : String(err)
  } finally {
    await cleanup()
  }

  verdict = reconcile(verdict, pixels)
  // Portrait media feed: a landscape page wastes the sheet unless it turns.
  const needsRotation = landscape
  // Same flag list the card renders, so chips and prose cannot drift apart.
  const notes = operatorBrief(
    verdict,
    jobFlags({ verdict, pixels, needsRotation })
  )
  const operatorNotes = modelWarning
    ? `${notes} Vision call failed: ${short(modelWarning)}`
    : notes

  const t1 = performance.now()
  return {
    fileName: args.fileName,
    byteSize: args.byteSize,
    mimeType: args.mimeType,
    page,
    pixels,
    verdict,
    needsRotation,
    operatorNotes,
    thumbnail: `data:image/png;base64,${thumbnail.toString("base64")}`,
    timingsMs: {
      raster: Math.round(tRaster - t0),
      pixels: Math.round(tPixels - tRaster),
      vision: Math.round(t1 - tPixels),
      total: Math.round(t1 - t0),
    },
    modelWarning,
  }
}

/**
 * The model judges what pixels cannot prove: what the job is, what to load.
 * Anything the pixel pass can measure, the pixel pass decides — e2b called a
 * blank-margin contract "bleeding" and a full-bleed invitation "safe".
 */
function reconcile(verdict: Verdict, pixels: PixelStats): Verdict {
  const measuredRisk = inkRiskFromLoad(pixels.inkLoadPct, pixels.peakTileInkPct)

  let hasBleedMargins = verdict.hasBleedMargins
  if (pixels.edgeInkPct >= BLEED_EDGE_PCT) hasBleedMargins = true
  else if (pixels.edgeInkPct <= BLEED_CLEAR_PCT) hasBleedMargins = false

  // Sticker and vinyl are the same job. The prompt says so and the model
  // follows it about half the time, so both directions get pinned here: a
  // sticker is vinyl, and alpha plus a vinyl choice means a die-cut job.
  const recommendedMedia =
    verdict.documentType === "sticker" ? VINYL_STOCK : verdict.recommendedMedia
  const documentType =
    pixels.hasTransparency && recommendedMedia === VINYL_STOCK
      ? "sticker"
      : verdict.documentType

  return {
    ...verdict,
    documentType,
    recommendedMedia,
    inkRiskLevel:
      riskRank(measuredRisk) > riskRank(verdict.inkRiskLevel)
        ? measuredRisk
        : verdict.inkRiskLevel,
    hasBleedMargins,
  }
}

const ORDER = { low: 0, medium: 1, high: 2 } as const
const riskRank = (level: keyof typeof ORDER) => ORDER[level]
const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 120)
