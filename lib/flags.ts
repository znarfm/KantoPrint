import {
  type InkRiskLevel,
  type MediaStock,
  type PixelStats,
  type Verdict,
  VINYL_STOCK,
} from "./prepress"

/** risk: stop and change the job. warn: change how you run it. note: look. */
/** Sparse page: the shape of a form, and the shape whose type is too small to read. */
export function isTextLike(
  p: Pick<PixelStats, "inkLoadPct" | "darkAreaPct">
): boolean {
  return p.inkLoadPct < 4 && p.darkAreaPct < 6
}

export type FlagTone = "risk" | "warn" | "note"

export type JobFlag = {
  id: string
  /** Chip text. */
  label: string
  tone: FlagTone
  /** Imperative sentence for the operator brief. */
  instruction: string
}

export type FlagInput = {
  verdict: Verdict
  pixels: PixelStats
  needsRotation: boolean
  /** Measured, not model-authored. See inkRiskFromLoad. */
  inkRiskLevel: InkRiskLevel
}

/**
 * The one place a condition becomes an operator instruction.
 *
 * Both surfaces read this: the card renders `label` as chips, and the pipeline
 * renders `instruction` into `operatorNotes`. Previously the same predicates
 * were written twice, so a flag could exist on the card and be missing from the
 * brief, or the reverse.
 */
export function jobFlags({
  verdict,
  pixels,
  needsRotation,
  inkRiskLevel,
}: FlagInput): JobFlag[] {
  const flags: JobFlag[] = []
  const onVinyl = verdict.recommendedMedia === VINYL_STOCK

  if (inkRiskLevel === "high") {
    flags.push(
      onVinyl
        ? {
            id: "ink-vinyl",
            label: "Heavy ink",
            tone: "risk",
            instruction: `Heavy ink ${pixels.inkLoadPct}%: matte side up, skip the pressure roller`,
          }
        : {
            id: "ink-soak",
            label: "Heavy ink soak",
            tone: "risk",
            instruction: `Heavy ink ${pixels.inkLoadPct}%: dry 10 min before stacking, expect curl`,
          }
    )
  } else if (inkRiskLevel === "medium") {
    flags.push({
      id: "ink-wet",
      label: "Drying risk",
      tone: "warn",
      instruction: `Ink ${pixels.inkLoadPct}%: print single-sided and let it dry`,
    })
  }

  if (verdict.hasBleedMargins) {
    flags.push(
      pixels.hasTransparency
        ? {
            id: "trim-artwork",
            label: "Artwork at trim",
            tone: "risk",
            instruction:
              "Artwork touches the trim: add 3 mm bleed before cutting",
          }
        : {
            id: "trim-ink",
            label: "Ink at trim",
            tone: "risk",
            instruction:
              "Ink reaches the trim: pull content in 3 mm or accept the edge",
          }
    )
  }

  if (needsRotation) {
    flags.push({
      id: "rotate",
      label: "Needs 90° turn",
      tone: "warn",
      instruction: "Rotate 90 degrees before feeding",
    })
  }

  if (verdict.documentType === "sticker") {
    flags.push({
      id: "kerf",
      label: "Cut test",
      tone: "note",
      instruction: "Test a corner cut for kerf before the full run",
    })
  }

  if (verdict.documentType === "photo" && pixels.peakTileInkPct > 40) {
    flags.push({
      id: "quality",
      label: "Quality mode",
      tone: "note",
      instruction: "Print best quality, not economy draft",
    })
  }

  if (verdict.documentType === "unknown") {
    flags.push({
      id: "unreadable",
      label: "Check by eye",
      tone: "warn",
      instruction: "Check the raster by eye before loading paper",
    })
  }

  return flags
}

/** Clean job: no flags fired, so say what to load and leave it there. */
export function operatorBrief(media: MediaStock, flags: JobFlag[]): string {
  if (flags.length === 0) {
    return `Load ${media} and print at 100% scale.`
  }
  return `${flags.map((f) => f.instruction).join("; ")}.`
}
