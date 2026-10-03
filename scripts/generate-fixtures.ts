/**
 * Deterministic test assets for the three triage cases.
 *   node scripts/generate-fixtures.ts
 *
 * No random values and no embedded dates: rerunning produces byte-identical
 * files, so a regression in the pipeline shows up as a verdict diff, not noise.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { PDFDocument, StandardFonts, cmyk, rgb } from "pdf-lib"
import sharp from "sharp"

const OUT = join(import.meta.dirname, "..", "fixtures")

const LINES = [
  "SERVICE AGREEMENT - SECTION 4.2",
  "",
  "1. The Supplier shall deliver goods within thirty (30) days of order.",
  "2. Title passes on receipt of payment in full.",
  "3. Neither party is liable for indirect or consequential loss.",
  "",
  "Signed for the Supplier: ______________________",
  "Signed for the Client:   ______________________",
]

/** 1. Low-ink monochrome contract. Letter, portrait, wide white margins. */
async function contractPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle("Service Agreement")
  doc.setProducer("KantoPrint fixtures")
  const page = doc.addPage([612, 792]) // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica)

  page.drawText("SERVICE AGREEMENT", {
    x: 72,
    y: 700,
    size: 18,
    font,
    color: rgb(0, 0, 0),
  })
  page.drawLine({
    start: { x: 72, y: 690 },
    end: { x: 540, y: 690 },
    thickness: 1,
    color: rgb(0, 0, 0),
  })

  LINES.forEach((line, i) => {
    page.drawText(line, {
      x: 72,
      y: 650 - i * 22,
      size: 11,
      font,
      color: rgb(0, 0, 0),
    })
  })

  return Buffer.from(await doc.save())
}

/** 2. 5x7 saturated invitation, full-bleed panels. Heavy ink soak case. */
async function invitationPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.setTitle("Invitation")
  doc.setProducer("KantoPrint fixtures")
  const page = doc.addPage([360, 504]) // 5 x 7 in
  const font = await doc.embedFont(StandardFonts.HelveticaBold)

  // Full-bleed dark panels: the worst case for curl and banding.
  page.drawRectangle({
    x: 0,
    y: 300,
    width: 360,
    height: 204,
    color: rgb(0.05, 0.11, 0.42),
  })
  page.drawRectangle({
    x: 0,
    y: 0,
    width: 360,
    height: 96,
    color: rgb(0.63, 0.09, 0.24),
  })

  page.drawText("SAVE THE DATE", {
    x: 34,
    y: 392,
    size: 34,
    font,
    color: rgb(1, 1, 1),
  })
  page.drawText("Kanto Print Open House", {
    x: 34,
    y: 340,
    size: 16,
    font,
    color: cmyk(0.05, 0.02, 0, 0),
  })
  page.drawText("SAT 14 NOV - 10:00", {
    x: 34,
    y: 36,
    size: 28,
    font,
    color: rgb(1, 1, 1),
  })

  return Buffer.from(await doc.save())
}

/** 3. Transparent circular badge flush with the canvas: sticker + zero bleed. */
async function badgePng(): Promise<Buffer> {
  const size = 1200
  const centre = size / 2
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${centre}" cy="${centre}" r="${centre - 2}" fill="#e8b923"/>
    <circle cx="${centre}" cy="${centre}" r="${centre - 46}" fill="none" stroke="#171717" stroke-width="18"/>
    <text x="${centre}" y="${centre - 34}" font-family="Helvetica" font-size="220"
      font-weight="bold" text-anchor="middle" fill="#171717">KSP</text>
    <text x="${centre}" y="${centre + 116}" font-family="Helvetica" font-size="96"
      text-anchor="middle" fill="#171717">EST 2026</text>
  </svg>`

  // The circle touches the edge by design: this is the zero-bleed case.
  return sharp(Buffer.from(svg)).png().toBuffer()
}

const FIXTURES: Array<[string, () => Promise<Buffer>]> = [
  ["01-contract-low-ink.pdf", contractPdf],
  ["02-invitation-heavy-ink.pdf", invitationPdf],
  ["03-badge-sticker-zero-bleed.png", badgePng],
]

await mkdir(OUT, { recursive: true })
for (const [name, build] of FIXTURES) {
  const buf = await build()
  await writeFile(join(OUT, name), buf)
  console.log(`${name}  ${(buf.byteLength / 1024).toFixed(1)} KB`)
}
