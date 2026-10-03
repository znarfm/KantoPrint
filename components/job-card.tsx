import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { INK_HIGH_PCT, INK_MEDIUM_PCT, type JobResult } from "@/lib/prepress"
import { cn } from "cn"
import type { CSSProperties } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  AlertCircleIcon,
  BrushIcon,
  Cancel01Icon,
  Rotate01Icon,
  SwatchBookIcon,
} from "@hugeicons/core-free-icons"

export type Job = {
  id: string
  name: string
  bytes: number
  /** Held for the request, released once the job reaches a terminal state. */
  file: File
  status: "queued" | "running" | "done" | "error"
  result?: JobResult
  error?: string
}

const RISK_STYLE = {
  low: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  high: "text-destructive",
} as const

/** Gauge fill colour by risk band. */
function riskColor(pct: number) {
  if (pct >= INK_HIGH_PCT) return "var(--destructive)"
  if (pct >= INK_MEDIUM_PCT) return "var(--chart-4)"
  return "var(--chart-3)"
}

function dimensions(page: JobResult["page"]) {
  const size =
    page.kind === "pdf"
      ? `${page.widthPt} x ${page.heightPt} pt`
      : `${page.widthPt} x ${page.heightPt} px @ ${page.rasterDpi} dpi`
  const imperial = `${page.widthIn} x ${page.heightIn} in`
  return { size, metric: `${page.widthMm} x ${page.heightMm} mm`, imperial }
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
          <p className="truncate text-sm font-medium">{job.name}</p>
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

  const { verdict, pixels, page, operatorNotes, needsRotation } = result
  const dims = dimensions(page)

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-heading text-sm font-medium">
            {job.name}
          </h3>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {dims.metric} · {dims.imperial} · {dims.size}
            {page.pageCount > 1 && ` · page 1 of ${page.pageCount}`}
          </p>
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
            {result.timingsMs.total} ms · vision {result.timingsMs.vision} ms
          </p>
        </div>

        {/* Middle: stock and the measured gauge. */}
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

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Ink load</span>
              <span
                className={cn(
                  "font-mono text-sm font-medium tabular-nums",
                  RISK_STYLE[verdict.inkRiskLevel]
                )}
              >
                {pixels.inkLoadPct}%
              </span>
            </div>
            <Progress
              value={Math.min(100, pixels.inkLoadPct)}
              // The band colour is data, so it rides in on a custom property
              // instead of a parallel element.
              style={
                { "--band": riskColor(pixels.inkLoadPct) } as CSSProperties
              }
              className="gap-0 [&_[data-slot=progress-indicator]]:bg-(--band) [&_[data-slot=progress-indicator]]:transition-none [&_[data-slot=progress-track]]:h-2"
            />
            <p className="font-mono text-[10px] text-muted-foreground">
              peak tile {pixels.peakTileInkPct}% · solid {pixels.darkAreaPct}% ·
              edge {pixels.edgeInkPct}% ·{" "}
              {pixels.saturation < 0.12 ? "mono" : "colour"}
            </p>
          </div>
        </div>

        {/* Right: the flags that change how the job runs. */}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {verdict.inkRiskLevel === "high" && (
              <Flag icon={BrushIcon} tone="destructive">
                Heavy ink soak
              </Flag>
            )}
            {verdict.hasBleedMargins && (
              <Flag icon={Alert02Icon} tone="destructive">
                {pixels.hasTransparency ? "Artwork at trim" : "Ink at trim"}
              </Flag>
            )}
            {needsRotation && (
              <Flag icon={Rotate01Icon} tone="warn">
                Needs 90° turn
              </Flag>
            )}
            {verdict.inkRiskLevel === "low" &&
              !verdict.hasBleedMargins &&
              !needsRotation && (
                <Flag icon={AlertCircleIcon} tone="ok">
                  No flags
                </Flag>
              )}
          </div>
          <p className="text-sm leading-snug text-pretty">{operatorNotes}</p>
          {result.modelWarning && (
            <p className="font-mono text-[10px] text-amber-600">
              {result.modelWarning}
            </p>
          )}
        </div>
      </div>
    </article>
  )
}

function Flag({
  icon,
  tone,
  children,
}: {
  icon: typeof BrushIcon
  tone: "destructive" | "warn" | "ok"
  children: React.ReactNode
}) {
  return (
    <Badge
      variant="outline"
      data-icon="inline-start"
      className={cn(
        tone === "destructive" && "border-destructive/40 text-destructive",
        tone === "warn" &&
          "border-amber-500/40 text-amber-600 dark:text-amber-400",
        tone === "ok" && "text-muted-foreground"
      )}
    >
      <HugeiconsIcon icon={icon} />
      {children}
    </Badge>
  )
}
