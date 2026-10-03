import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { PDFDocument } from "pdf-lib"
import sharp from "sharp"

import { ptToIn, ptToMm, pxToIn, pxToMm, type PageInfo } from "./prepress"

const exec = promisify(execFile)

export const RASTER_DPI = Number(process.env.KANTOPRINT_DPI ?? 150)

/**
 * Vision input size. Measured on this box: 256px loses the artwork (the model
 * calls a badge "unknown"), 384px classifies correctly at roughly half the
 * vision-encode cost of 512px. The encoder runs at input resolution, so this
 * is the single biggest latency lever.
 */
export const THUMB_PX = Number(process.env.KANTOPRINT_THUMB ?? 384)

/** Vision input. Flattened to white so transparency reads as paper stock. */
const thumbnail = (raster: Buffer) =>
  sharp(raster)
    .flatten({ background: "#ffffff" })
    .resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer()

export class RasterError extends Error {}

/**
 * sharp cannot decode PDF (no poppler in its prebuilt libvips), so a native
 * rasterizer is required. poppler first, ghostscript second — both ship with
 * common desktop Linux, and neither is reachable over the air anyway.
 */
async function rasterizePdf(pdf: Buffer, dir: string): Promise<Buffer> {
  const src = join(dir, "in.pdf")
  await writeFile(src, pdf)

  try {
    await exec("pdftoppm", [
      "-png",
      "-r",
      String(RASTER_DPI),
      "-f",
      "1",
      "-l",
      "1",
      "-singlefile",
      src,
      join(dir, "page"),
    ])
    return await readFile(join(dir, "page.png"))
  } catch (err) {
    const popplerError = err instanceof Error ? err.message : String(err)
    try {
      await exec("gs", [
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-dFirstPage=1",
        "-dLastPage=1",
        `-r${RASTER_DPI}`,
        "-sDEVICE=png16m",
        `-sOutputFile=${join(dir, "page.png")}`,
        src,
      ])
      return await readFile(join(dir, "page.png"))
    } catch {
      throw new RasterError(
        `No PDF rasterizer. Install poppler-utils (pdftoppm) or ghostscript. pdftoppm said: ${popplerError.split("\n")[0]}`
      )
    }
  }
}

export type Prepared = {
  page: PageInfo
  /** Full-resolution raster, used for pixel stats. */
  raster: Buffer
  /** Downscaled PNG for the vision model. */
  thumbnail: Buffer
  cleanup: () => Promise<void>
}

/**
 * Step A + B: page metadata and a bounded raster. PDF page boxes come from
 * pdf-lib; image dimensions and DPI come from sharp.
 */
export async function prepareRaster(
  file: Buffer,
  mimeType: string
): Promise<Prepared> {
  const dir = await mkdtemp(join(tmpdir(), "kantoprint-"))
  const cleanup = () => rm(dir, { recursive: true, force: true })

  try {
    if (
      mimeType === "application/pdf" ||
      file.subarray(0, 5).toString() === "%PDF-"
    ) {
      const doc = await PDFDocument.load(file, { updateMetadata: false })
      const first = doc.getPage(0)
      const { width, height } = first.getSize()
      const pageCount = doc.getPageCount()
      const raster = await rasterizePdf(file, dir)

      return {
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
          pagesAnalyzed: 1,
        },
        raster,
        thumbnail: await thumbnail(raster),
        cleanup,
      }
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
        pagesAnalyzed: null,
      },
      raster,
      thumbnail: await thumbnail(raster),
      cleanup,
    }
  } catch (err) {
    await cleanup()
    throw err
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100
