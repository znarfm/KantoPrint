/**
 * Opt-in: drives the real daemon and the real rasteriser, so it is excluded
 * from `pnpm test` and run with `pnpm test:model`. CI has no Ollama.
 *
 *   ollama pull gemma4:e2b && pnpm test:model
 *
 * This is the only place the acceptance criteria are asserted: every reply
 * parses, and no page takes absurdly long.
 */
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { beforeAll, describe, expect, it } from "vitest"

import { checkHealth, MODEL } from "@/lib/judge"
import { runPreflight } from "@/lib/preflight"
import { pageResultSchema, type PageResult } from "@/lib/prepress"

const exec = promisify(execFile)
const ROOT = join(import.meta.dirname, "..")
const FIXTURES = join(ROOT, "fixtures")

/** Generous: the box is shared and a cold model load costs ~30s. */
const PER_PAGE_BUDGET_MS = 60_000

let available = false

beforeAll(async () => {
  const health = await checkHealth()
  available = health.reachable && health.modelPresent
  if (!available) {
    console.warn(
      `[model] skipped: ${health.reachable ? `${MODEL} not pulled` : "ollama unreachable"}`
    )
    return
  }
  // Fixtures are generated artefacts, not committed.
  await exec("node", [join(ROOT, "scripts", "generate-fixtures.ts")])
}, 180_000)

const CASES = [
  {
    file: "01-contract-low-ink.pdf",
    mimeType: "application/pdf",
    documentType: "document",
    media: ["70-80 GSM Bond", "Plain Recycled 100 GSM"],
  },
  {
    file: "02-invitation-heavy-ink.pdf",
    mimeType: "application/pdf",
    documentType: "invitation",
    media: ["220+ GSM Matte Cardstock", "300 GSM Photo Board"],
  },
  {
    file: "03-badge-sticker-zero-bleed.png",
    mimeType: "image/png",
    documentType: "sticker",
    media: ["Glossy Vinyl Sticker Sheet"],
  },
] as const

describe(`preflight against ${MODEL}`, () => {
  it.each(CASES)(
    "triages $file",
    async ({ file, mimeType, documentType, media }) => {
      if (!available) return

      const buffer = await readFile(join(FIXTURES, file))
      const pages: PageResult[] = []

      await runPreflight({
        fileName: file,
        byteSize: buffer.byteLength,
        mimeType,
        buffer,
        detail: false,
        onPage: (p) => {
          // The acceptance criterion: every reply parses, every time.
          expect(pageResultSchema.safeParse(p).success).toBe(true)
          expect(p.timingsMs.total).toBeLessThan(PER_PAGE_BUDGET_MS)
          pages.push(p)
        },
      })

      expect(pages.length).toBeGreaterThan(0)
      const first = pages[0]
      expect(first.verdict.documentType).toBe(documentType)
      expect(media).toContain(first.verdict.recommendedMedia)
      // Every page must carry an operator instruction.
      expect(first.operatorNotes.length).toBeGreaterThan(0)
    }
  )

  it("analyses every page of a multi-page PDF", async () => {
    if (!available) return

    const { PDFDocument } = await import("pdf-lib")
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i += 1) doc.addPage([360, 504])
    const buffer = Buffer.from(await doc.save())

    const pages: PageResult[] = []
    const summary = await runPreflight({
      fileName: "three.pdf",
      byteSize: buffer.byteLength,
      mimeType: "application/pdf",
      buffer,
      detail: false,
      onPage: (p) => void pages.push(p),
    })

    expect(summary.pageCount).toBe(3)
    expect(pages.map((p) => p.index)).toEqual([1, 2, 3])
    expect(summary.pagesSkipped).toBe(0)
  }, 180_000)

  it("stops between pages when the caller aborts", async () => {
    if (!available) return

    const { PDFDocument } = await import("pdf-lib")
    const doc = await PDFDocument.create()
    for (let i = 0; i < 4; i += 1) doc.addPage([360, 504])
    const buffer = Buffer.from(await doc.save())

    const controller = new AbortController()
    let seen = 0
    await expect(
      runPreflight({
        fileName: "four.pdf",
        byteSize: buffer.byteLength,
        mimeType: "application/pdf",
        buffer,
        detail: false,
        signal: controller.signal,
        onPage: (p) => {
          seen += 1
          if (p.index === 1) controller.abort()
        },
      })
    ).rejects.toThrow(/Cancelled/)

    expect(seen).toBeLessThan(4)
  }, 180_000)
})
