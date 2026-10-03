import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { PDFDocument } from "pdf-lib"
import sharp from "sharp"

import { ptToIn, ptToMm, pxToIn, pxToMm, type PageInfo } from "./prepress"

const exec = promisify(execFile)

export const RASTER_DPI = Number(process.env.KANTOPRINT_DPI ?? 150)

/**
 * Pages analysed per file. Vision is serial and costs seconds a page, so an
 * unbounded loop turns a 200-page deck into an hour-long job with no feedback.
 */
export const MAX_PAGES = Number(process.env.KANTOPRINT_MAX_PAGES ?? 20)

/**
 * Vision input size. Measured on this box: 256px loses the artwork (the model
 * calls a badge "unknown"), 384px classifies correctly at roughly half the
 * vision-encode cost of 512px. The encoder runs at input resolution, so this
 * is the single biggest latency lever.
 */
export const THUMB_PX = Number(process.env.KANTOPRINT_THUMB ?? 384)

/** Detail mode for small type: an 11pt line on Letter is ~4.6px at 384. */
export const THUMB_PX_DETAIL = Number(
  process.env.KANTOPRINT_THUMB_DETAIL ?? 512
)

/**
 * Hard ceiling on a child process. A malformed PDF can otherwise hang the
 * request forever and strand its temp directory.
 */
const RASTER_TIMEOUT_MS = Number(
  process.env.KANTOPRINT_RASTER_TIMEOUT ?? 45_000
)

function thumbnail(raster: Buffer, px: number) {
  return (
    sharp(raster)
      // Flattened to white so transparency reads as paper stock.
      .flatten({ background: "#ffffff" })
      .resize(px, px, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer()
  )
}

export class RasterError extends Error {}

/**
 * sharp cannot decode PDF (no poppler in its prebuilt libvips), so a native
 * rasteriser is required. poppler first, ghostscript second — both ship with
 * common desktop Linux, and neither is reachable over the air anyway.
 *
 * Poppler zero-pads its output to the digit count of the last page rendered, so
 * the files are collected and sorted numerically rather than by name.
 */
async function rasterizePdfPages(
  pdf: Buffer,
  dir: string,
  count: number
): Promise<Buffer[]> {
  const src = join(dir, "in.pdf")
  const prefix = join(dir, "pg")
  await writeFile(src, pdf)

  const readAll = async () => {
    const names = await readdir(dir)
    const pages = names.filter((n) => n.startsWith("pg-") && n.endsWith(".png"))
    pages.sort((a, b) => Number(a.slice(3, -4)) - Number(b.slice(3, -4)))
    if (pages.length === 0)
      throw new RasterError("Rasteriser produced no pages.")
    return Promise.all(pages.map((n) => readFile(join(dir, n))))
  }

  try {
    await exec(
      "pdftoppm",
      [
        "-png",
        "-r",
        String(RASTER_DPI),
        "-f",
        "1",
        "-l",
        String(count),
        src,
        prefix,
      ],
      { timeout: RASTER_TIMEOUT_MS, maxBuffer: 1 << 20 }
    )
    return await readAll()
  } catch (err) {
    const reason = describe(err, "pdftoppm")
    try {
      await exec(
        "gs",
        [
          "-q",
          "-dNOPAUSE",
          "-dBATCH",
          "-dSAFER",
          "-dFirstPage=1",
          `-dLastPage=${count}`,
          `-r${RASTER_DPI}`,
          "-sDEVICE=png16m",
          `-sOutputFile=${join(dir, "pg-%03d.png")}`,
          src,
        ],
        { timeout: RASTER_TIMEOUT_MS, maxBuffer: 1 << 20 }
      )
      return await readAll()
    } catch {
      throw new RasterError(
        `No usable PDF rasteriser. Install poppler-utils (pdftoppm) or ghostscript. ${reason}`
      )
    }
  }
}

/** Turn an execFile failure into something an operator can act on. */
function describe(err: unknown, tool: string): string {
  const e = err as {
    killed?: boolean
    code?: string | number
    message?: string
  }
  if (e?.killed)
    return `${tool} exceeded the ${RASTER_TIMEOUT_MS / 1000}s limit; the PDF is malformed or too complex.`
  if (e?.code === "ENOENT") return `${tool} is not installed.`
  if (e?.code === "password" || /password/i.test(e?.message ?? ""))
    return "This PDF is password protected. Remove the password and retry."
  const first = (e?.message ?? String(err)).split("\n")[0]
  return `${tool}: ${first.slice(0, 160)}`
}

export type PreparedPage = {
  page: PageInfo
  /** Full-resolution raster, used for pixel stats. */
  raster: Buffer
  /** Downscaled PNG for the vision model. */
  thumbnail: Buffer
  /** True when small type is below what the model can read at this size. */
  lowDetail: boolean
}

export type Prepared = {
  pages: PreparedPage[]
  /** Pages in the document that were not analysed. */
  pagesSkipped: number
  cleanup: () => Promise<void>
}

/**
 * Step A + B for every page: page boxes from pdf-lib, dimensions and DPI from
 * sharp. Returns them all so the caller can stream results as they finish
 * rather than holding the whole document until the last page.
 */
export async function prepareRaster(args: {
  file: Buffer
  mimeType: string
  detail: boolean
}): Promise<Prepared> {
  const { file, mimeType, detail } = args
  const dir = await mkdtemp(join(tmpdir(), "kantoprint-"))
  const cleanup = () => rm(dir, { recursive: true, force: true })
  const px = detail ? THUMB_PX_DETAIL : THUMB_PX

  try {
    const isPdf =
      mimeType === "application/pdf" ||
      file.subarray(0, 5).toString() === "%PDF-"

    if (isPdf) {
      const doc = await PDFDocument.load(file, { updateMetadata: false })
      const pageCount = doc.getPageCount()
      if (pageCount === 0) throw new RasterError("This PDF has no pages.")

      const analysed = Math.min(pageCount, MAX_PAGES)
      const rasters = await rasterizePdfPages(file, dir, analysed)

      const pages: PreparedPage[] = []
      for (const [i, p] of doc.getPages().slice(0, analysed).entries()) {
        const { width, height } = p.getSize()
        const raster = rasters[i]
        pages.push({
          page: {
            kind: "pdf",
            widthPt: round2(width),
            heightPt: round2(height),
            widthMm: round1(ptToMm(width)),
            heightMm: round1(ptToMm(height)),
            widthIn: round2(ptToIn(width)),
            heightIn: round2(ptToIn(height)),
            pageCount,
            rasterDpi: RASTER_DPI,
          },
          raster,
          thumbnail: await thumbnail(raster, px),
          lowDetail: !detail,
        })
      }

      return { pages, pagesSkipped: pageCount - analysed, cleanup }
    }

    const meta = await sharp(file, { limitInputPixels: 80_000_000 }).metadata()
    if (!meta.width || !meta.height) {
      throw new RasterError("Not a decodable image or PDF.")
    }
    // No embedded DPI on screen exports: assume 96 and let the model see pixels
    // for what they are.
    const dpi = meta.density && meta.density > 1 ? Math.round(meta.density) : 96
    // Keep alpha: analyzePixels needs it to spot cut paths. The thumbnail is
    // flattened to white separately so the vision model reads paper, not void.
    const raster = await sharp(file, { limitInputPixels: 80_000_000 })
      .png()
      .toBuffer()

    return {
      pages: [
        {
          page: {
            kind: "image",
            widthPt: meta.width,
            heightPt: meta.height,
            widthMm: round1(pxToMm(meta.width, dpi)),
            heightMm: round1(pxToMm(meta.height, dpi)),
            widthIn: round2(pxToIn(meta.width, dpi)),
            heightIn: round2(pxToIn(meta.height, dpi)),
            pageCount: 1,
            rasterDpi: dpi,
          },
          raster,
          thumbnail: await thumbnail(raster, px),
          lowDetail: !detail,
        },
      ],
      pagesSkipped: 0,
      cleanup,
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100
