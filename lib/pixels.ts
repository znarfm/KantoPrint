import sharp from "sharp"

import type { PixelStats } from "./prepress"

/** Tile size in px for the local-soak probe. */
const TILE = 64

/** Edge band as a fraction of the short side: ~3 mm on A4/Letter at 150 dpi. */
const EDGE_BAND_RATIO = 0.03

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * One deterministic pass over the raster. Every number on the gauge comes from
 * here, so the model can misjudge ink load and the measurement still stands.
 * Transparent pixels are flattened to white: a cut path is paper, not ink.
 */
export async function analyzePixels(input: Buffer): Promise<PixelStats> {
  const hasTransparency = (await sharp(input).metadata()).hasAlpha === true

  const { data, info } = await sharp(input, { limitInputPixels: 80_000_000 })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const total = width * height

  const tilesX = Math.max(1, Math.ceil(width / TILE))
  const tilesY = Math.max(1, Math.ceil(height / TILE))
  const tileSum = new Float64Array(tilesX * tilesY)
  const tileCount = new Uint32Array(tilesX * tilesY)

  const band = Math.max(
    2,
    Math.round(Math.min(width, height) * EDGE_BAND_RATIO)
  )

  let inkSum = 0
  let darkCount = 0
  let edgeInkSum = 0
  let edgeCount = 0
  let satSum = 0

  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band
    const ty = Math.min(tilesY - 1, (y / TILE) | 0)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]

      const ink = 1 - (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      inkSum += ink
      if (ink >= 0.5) darkCount++

      const mx = Math.max(r, g, b)
      satSum += mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx

      if (edgeRow || x < band || x >= width - band) {
        edgeInkSum += ink
        edgeCount++
      }

      const ti = ty * tilesX + Math.min(tilesX - 1, (x / TILE) | 0)
      tileSum[ti] += ink
      tileCount[ti]++
    }
  }

  let peakTileInk = 0
  for (let t = 0; t < tileSum.length; t++) {
    if (tileCount[t] === 0) continue
    const mean = (tileSum[t] / tileCount[t]) * 100
    if (mean > peakTileInk) peakTileInk = mean
  }

  return {
    inkLoadPct: round1((inkSum / total) * 100),
    darkAreaPct: round1((darkCount / total) * 100),
    peakTileInkPct: round1(peakTileInk),
    edgeInkPct: round1((edgeInkSum / Math.max(1, edgeCount)) * 100),
    saturation: round2(satSum / total),
    hasTransparency,
  }
}
