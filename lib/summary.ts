import { jobFlags } from "./flags"
import { MEDIA_STOCKS, type JobResult, type MediaStock } from "./prepress"

export type TrayGroup = { stock: MediaStock; count: number }

/** Which trays this batch actually needs, in tray order. */
export function trayBreakdown(results: JobResult[]): TrayGroup[] {
  const counts = new Map<MediaStock, number>()
  for (const r of results) {
    const stock = r.verdict.recommendedMedia
    counts.set(stock, (counts.get(stock) ?? 0) + 1)
  }
  return MEDIA_STOCKS.filter((s) => counts.has(s)).map((stock) => ({
    stock,
    count: counts.get(stock) ?? 0,
  }))
}

export function inTray(result: JobResult, tray: MediaStock | "all"): boolean {
  return tray === "all" || result.verdict.recommendedMedia === tray
}

/**
 * Paste-ready load sheet: one block per tray, flagged jobs indented under it.
 */
export function batchSummary(results: JobResult[]): string {
  if (results.length === 0) return ""

  const blocks = trayBreakdown(results).map(({ stock, count }) => {
    const members = results.filter((r) => r.verdict.recommendedMedia === stock)
    const flagged = members.flatMap((r) =>
      jobFlags({
        verdict: r.verdict,
        pixels: r.pixels,
        needsRotation: r.needsRotation,
      })
        .filter((f) => f.tone !== "note")
        .map((f) => `${r.fileName} (${f.label.toLowerCase()})`)
    )
    return flagged.length > 0
      ? `${stock} x${count}\n  ${flagged.join("\n  ")}`
      : `${stock} x${count}`
  })

  return `KantoPrint batch: ${results.length} job(s)\n\n${blocks.join("\n\n")}`
}
