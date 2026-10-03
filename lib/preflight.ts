import { analyzePixels } from "./pixels"
import {
  BLEED_CLEAR_PCT,
  BLEED_EDGE_PCT,
  MEDIA_STOCKS,
  VINYL_STOCK,
  inkRiskFromLoad,
  pageResultSchema,
  type JobResult,
  type PageResult,
  type PixelStats,
  type Verdict,
} from "./prepress"
import { jobFlags, operatorBrief } from "./flags"
import { judgeVerdict, inkProfile } from "./judge"
import { prepareRaster, THUMB_PX, THUMB_PX_DETAIL } from "./raster"

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
 * The browser-supplied MIME lies often enough to matter, so magic bytes decide.
 * There is deliberately no fallback to the declared type: PDF, PNG and JPEG all
 * have signatures, so an unrecognised head means the file is not what it claims
 * and failing here gives a better message than pdf-lib would.
 */
export async function ingest(file: File): Promise<Ingest> {
  const buffer = Buffer.from(await file.arrayBuffer())
  const head = buffer.subarray(0, 12)
  const startsWith = (sig: number[]) => sig.every((b, i) => head[i] === b)

  if (buffer.byteLength === 0) throw new Error(`${file.name}: empty file.`)

  let mimeType: keyof typeof ACCEPTED | null = null
  if (startsWith(PDF)) mimeType = "application/pdf"
  else if (startsWith(PNG)) mimeType = "image/png"
  else if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    mimeType = "image/jpeg"

  if (!mimeType) {
    throw new Error(`${file.name}: only PDF, PNG and JPEG are accepted.`)
  }
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(
      `${file.name}: ${mb(buffer.byteLength)} exceeds the ${mb(MAX_BYTES)} cap.`
    )
  }

  return { fileName: file.name, byteSize: buffer.byteLength, mimeType, buffer }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export type PreflightSummary = {
  pageCount: number
  pagesSkipped: number
  timingsMsTotal: number
}

export class AbortedError extends Error {
  constructor() {
    super("Cancelled.")
    this.name = "AbortedError"
  }
}

/** One page through steps B, C and D. */
async function preflightPage(args: {
  index: number
  pageCount: number
  prepared: Awaited<ReturnType<typeof prepareRaster>>["pages"][number]
  detail: boolean
  signal?: AbortSignal
}): Promise<PageResult> {
  const { index, pageCount, prepared, detail, signal } = args
  const { page, raster, thumbnail, lowDetail } = prepared

  const tRaster = performance.now()
  const pixels = await analyzePixels(raster)
  const tPixels = performance.now()

  const landscape = page.widthPt > page.heightPt
  let verdict: Verdict
  let modelWarning: string | null = null

  try {
    throwIfAborted(signal)
    const judged = await judgeVerdict({
      thumbnail,
      kind: page.kind,
      pageIndex: index,
      pageCount,
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
    if (signal?.aborted) throw new AbortedError()
    // Ollama down, or the model missed the contract twice. The operator still
    // gets the measured half of the job instead of a blank card.
    verdict = {
      documentType: "unknown",
      recommendedMedia: MEDIA_STOCKS[0],
      hasBleedMargins: pixels.edgeInkPct >= BLEED_EDGE_PCT,
    }
    modelWarning = err instanceof Error ? err.message : String(err)
  }

  verdict = reconcile(verdict, pixels)
  const inkRiskLevel = inkRiskFromLoad(pixels.inkLoadPct, pixels.peakTileInkPct)
  // Portrait media feed: a landscape page wastes the sheet unless it turns.
  const needsRotation = landscape
  const notes = operatorBrief(
    verdict.recommendedMedia,
    jobFlags({ verdict, pixels, needsRotation, inkRiskLevel })
  )

  const t1 = performance.now()
  return pageResultSchema.parse({
    index,
    page,
    pixels,
    verdict,
    inkRiskLevel,
    needsRotation,
    operatorNotes: modelWarning
      ? `${notes} Vision call failed: ${short(modelWarning)}`
      : notes,
    thumbnail: `data:image/png;base64,${thumbnail.toString("base64")}`,
    lowDetail,
    thumbPx: detail ? THUMB_PX_DETAIL : THUMB_PX,
    timingsMs: {
      raster: 0,
      pixels: Math.round(tPixels - tRaster),
      vision: Math.round(t1 - tPixels),
      total: Math.round(t1 - tRaster),
    },
    modelWarning,
  })
}

/**
 * Steps A through D for a whole file. Pages are handed to `onPage` as they
 * finish so a long PDF reports progress instead of going quiet for a minute,
 * and `signal` lets the client abandon the rest of the document.
 */
export async function runPreflight(args: {
  fileName: string
  byteSize: number
  mimeType: string
  buffer: Buffer
  detail: boolean
  signal?: AbortSignal
  onPage: (page: PageResult) => void | Promise<void>
}): Promise<PreflightSummary> {
  const t0 = performance.now()
  const prepared = await prepareRaster({
    file: args.buffer,
    mimeType: args.mimeType,
    detail: args.detail,
  })

  try {
    const pageCount = prepared.pages[0]?.page.pageCount ?? 1
    for (const [i, page] of prepared.pages.entries()) {
      throwIfAborted(args.signal)
      await args.onPage(
        await preflightPage({
          index: i + 1,
          pageCount,
          prepared: page,
          detail: args.detail,
          signal: args.signal,
        })
      )
    }
    return {
      pageCount,
      pagesSkipped: prepared.pagesSkipped,
      timingsMsTotal: Math.round(performance.now() - t0),
    }
  } finally {
    await prepared.cleanup()
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortedError()
}

/**
 * The model judges what pixels cannot prove: what the job is, what to load.
 * Anything the pixel pass can measure, the pixel pass decides — e2b called a
 * blank-margin contract "bleeding" and a full-bleed invitation "safe".
 *
 * Ink risk is not here on purpose: it is measured outright, because asking the
 * model for it produced a band that disagreed with the gauge printed beside it.
 */
export function reconcile(verdict: Verdict, pixels: PixelStats): Verdict {
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

  return { ...verdict, documentType, recommendedMedia, hasBleedMargins }
}

const short = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).slice(0, 120)

export type { JobResult }
