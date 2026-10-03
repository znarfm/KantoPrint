import { Badge } from "@/components/ui/badge"
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { jobFlags } from "@/lib/flags"
import type { JobResult } from "@/lib/prepress"
import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  AlertCircleIcon,
  BrushIcon,
  Cancel01Icon,
  CircleIcon,
  PrinterIcon,
  Rotate01Icon,
  SwatchBookIcon,
} from "@hugeicons/core-free-icons"
import type { Job } from "@/hooks/use-job-queue"

/** Icons stay in the view layer; lib/flags.ts owns meaning, not glyphs. */
const FLAG_ICON: Record<string, typeof Alert02Icon> = {
  "ink-soak": BrushIcon,
  "ink-vinyl": BrushIcon,
  "ink-wet": BrushIcon,
  "trim-ink": Alert02Icon,
  "trim-artwork": Alert02Icon,
  rotate: Rotate01Icon,
  kerf: CircleIcon,
  quality: PrinterIcon,
  unreadable: AlertCircleIcon,
}

/** shadcn variants carry the tone; only warn needs a hue the palette lacks. */
const TONE_VARIANT = {
  risk: "destructive",
  warn: "outline",
  note: "ghost",
} as const

const RISK_TEXT = {
  low: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  high: "text-destructive",
} as const

function Dimension({ page }: { page: JobResult["page"] }) {
  const size =
    page.kind === "pdf"
      ? `${page.widthPt} x ${page.heightPt} pt`
      : `${page.widthPt} x ${page.heightPt} px @ ${page.rasterDpi} dpi`

  return (
    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
      {page.widthMm} x {page.heightMm} mm · {page.widthIn} x {page.heightIn} in
      · {size}
      {page.pageCount > 1 && ` · page 1 of ${page.pageCount}`}
    </p>
  )
}

function InkGauge({ result }: { result: JobResult }) {
  const { pixels, verdict } = result

  return (
    <div className="space-y-1.5">
      <Progress value={Math.min(100, pixels.inkLoadPct)} className="gap-0">
        <ProgressLabel className="text-xs text-muted-foreground">
          Ink load
        </ProgressLabel>
        <ProgressValue
          className={cn(
            "font-mono font-medium",
            RISK_TEXT[verdict.inkRiskLevel]
          )}
        >
          {() => `${pixels.inkLoadPct}%`}
        </ProgressValue>
      </Progress>
      <p className="font-mono text-[10px] text-muted-foreground">
        peak tile {pixels.peakTileInkPct}% · solid {pixels.darkAreaPct}% · edge{" "}
        {pixels.edgeInkPct}% · {pixels.saturation < 0.12 ? "mono" : "colour"}
      </p>
    </div>
  )
}

function FlagChips({ result }: { result: JobResult }) {
  const flags = jobFlags(result)

  if (flags.length === 0) {
    return (
      <Badge variant="ghost" data-icon="inline-start">
        <HugeiconsIcon icon={AlertCircleIcon} />
        No flags
      </Badge>
    )
  }

  return (
    <>
      {flags.map((f) => (
        <Badge
          key={f.id}
          variant={TONE_VARIANT[f.tone]}
          data-icon="inline-start"
          className={cn(
            f.tone === "warn" &&
              "border-amber-500/40 text-amber-600 dark:text-amber-400"
          )}
        >
          <HugeiconsIcon icon={FLAG_ICON[f.id] ?? Alert02Icon} />
          {f.label}
        </Badge>
      ))}
    </>
  )
}

export function JobCard({ job }: { job: Job }) {
  if (job.status === "error") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="min-w-0">
          <p className="truncate font-heading text-sm font-medium">
            {job.name}
          </p>
          <p className="mt-1 text-sm text-destructive/90">{job.error}</p>
        </div>
      </div>
    )
  }

  const result = job.result
  if (job.status !== "done" || !result) {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-4">
        <Skeleton className="size-14 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
        <Badge variant="secondary">{job.status}</Badge>
      </div>
    )
  }

  const { verdict, page, timingsMs, modelWarning } = result

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-heading text-sm font-medium">
            {job.name}
          </h3>
          <Dimension page={page} />
        </div>
        <Badge variant="outline" className="capitalize">
          {verdict.documentType}
        </Badge>
      </header>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-[7rem_1fr_1fr]">
        {/* Left: the raster the model actually saw. */}
        <div className="flex flex-col gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={result.thumbnail}
            alt={`Page 1 raster of ${job.name}`}
            className="w-full rounded-md border bg-white object-contain"
          />
          <p className="font-mono text-[10px] text-muted-foreground">
            {timingsMs.total} ms · vision {timingsMs.vision} ms
          </p>
        </div>

        {/* Middle: tray stock and the measured gauge. */}
        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground">Load tray</p>
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <HugeiconsIcon
                icon={SwatchBookIcon}
                className="size-4 text-muted-foreground"
              />
              {verdict.recommendedMedia}
            </p>
          </div>
          <InkGauge result={result} />
        </div>

        {/* Right: the flags that change how the job runs. */}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <FlagChips result={result} />
          </div>
          <p className="text-sm leading-snug text-pretty">
            {result.operatorNotes}
          </p>
          {modelWarning && (
            <p className="font-mono text-[10px] text-amber-600">
              {modelWarning}
            </p>
          )}
        </div>
      </div>
    </article>
  )
}
