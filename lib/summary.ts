import { jobFlags } from "./flags"
import { MEDIA_STOCKS, type JobResult, type MediaStock } from "./prepress"

export type TrayGroup = { stock: MediaStock; count: number }

/**
 * The tray a file is filed under: whichever stock most of its pages asked for.
 * A mixed document has to land somewhere, and the majority is the honest answer.
 * Ties fall to page 1 because that is the page the card leads with.
 */
export function dominantMedia(result: JobResult): MediaStock {
  const counts = new Map<MediaStock, number>()
  for (const p of result.pages) {
    const stock = p.verdict.recommendedMedia
    counts.set(stock, (counts.get(stock) ?? 0) + 1)
  }
  let best = result.pages[0].verdict.recommendedMedia
  let bestCount = 0
  for (const stock of MEDIA_STOCKS) {
    const n = counts.get(stock) ?? 0
    if (n > bestCount) {
      best = stock
      bestCount = n
    }
  }
  return best
}

/** True when the pages disagree about the tray, which the card should say. */
export function isMixedMedia(result: JobResult): boolean {
  return new Set(result.pages.map((p) => p.verdict.recommendedMedia)).size > 1
}

/** Which trays this batch actually needs, in tray order. */
export function trayBreakdown(results: JobResult[]): TrayGroup[] {
  const counts = new Map<MediaStock, number>()
  for (const r of results) {
    const stock = dominantMedia(r)
    counts.set(stock, (counts.get(stock) ?? 0) + 1)
  }
  return MEDIA_STOCKS.filter((s) => counts.has(s)).map((stock) => ({
    stock,
    count: counts.get(stock) ?? 0,
  }))
}

export function inTray(result: JobResult, tray: MediaStock | "all"): boolean {
  return tray === "all" || dominantMedia(result) === tray
}

/**
 * Paste-ready load sheet: one block per tray, then every flagged page under it.
 * Pages are labelled by index so "p5" means page 5 in the reader.
 */
export function batchSummary(results: JobResult[]): string {
  if (results.length === 0) return ""

  const blocks = trayBreakdown(results).map(({ stock, count }) => {
    const members = results.filter((r) => dominantMedia(r) === stock)
    const rows = members.flatMap((r) => {
      const multi = r.pages.length > 1
      const flagged = r.pages.flatMap((p) =>
        jobFlags({
          verdict: p.verdict,
          pixels: p.pixels,
          needsRotation: p.needsRotation,
          inkRiskLevel: p.inkRiskLevel,
        })
          .filter((f) => f.tone !== "note")
          .map(
            (f) =>
              `  ${multi ? `p${p.index} ` : ""}${r.fileName} (${f.label.toLowerCase()})`
          )
      )
      return flagged.length > 0 ? flagged : [`  ${r.fileName}  ok`]
    })
    return [`${stock} x${count}`, ...rows].join("\n")
  })

  const pages = results.reduce((n, r) => n + r.pages.length, 0)
  return `KantoPrint batch: ${results.length} file(s), ${pages} page(s)\n\n${blocks.join("\n\n")}`
}
