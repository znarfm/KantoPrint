"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { isTextLike, jobFlags } from "@/lib/flags"
import { isMixedMedia } from "@/lib/summary"
import type { JobResult, PageResult } from "@/lib/prepress"
import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  AlertCircleIcon,
  ArrowUpDownIcon,
  BrushIcon,
  Cancel01Icon,
  ChevronDownIcon,
  CircleIcon,
  PrinterIcon,
  RefreshIcon,
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

function Dimension({ page }: { page: PageResult["page"] }) {
  const size =
    page.kind === "pdf"
      ? `${page.widthPt} x ${page.heightPt} pt`
      : `${page.widthPt} x ${page.heightPt} px @ ${page.rasterDpi} dpi`

  return (
    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
      {page.widthMm} x {page.heightMm} mm · {page.widthIn} x {page.heightIn} in
      · {size}
    </p>
  )
}

function InkGauge({ page }: { page: PageResult }) {
  return (
    <div className="space-y-1.5">
      <Progress value={Math.min(100, page.pixels.inkLoadPct)} className="gap-0">
        <ProgressLabel className="text-xs text-muted-foreground">
          Ink load
        </ProgressLabel>
        <ProgressValue
          className={cn("font-mono font-medium", RISK_TEXT[page.inkRiskLevel])}
        >
          {() => `${page.pixels.inkLoadPct}%`}
        </ProgressValue>
      </Progress>
      <p className="font-mono text-[10px] text-muted-foreground">
        peak tile {page.pixels.peakTileInkPct}% · solid{" "}
        {page.pixels.darkAreaPct}% · edge {page.pixels.edgeInkPct}% ·{" "}
        {page.pixels.saturation < 0.12 ? "mono" : "colour"}
      </p>
    </div>
  )
}

function FlagChips({ page }: { page: PageResult }) {
  const flags = jobFlags(page)

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

/** One page: the raster the model saw, the gauge, and the flags. */
function PageBody({
  page,
  compact = false,
}: {
  page: PageResult
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        compact
          ? "sm:grid-cols-[5rem_1fr]"
          : "sm:grid-cols-2 lg:grid-cols-[7rem_1fr_1fr]"
      )}
    >
      <div className="flex flex-col gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={page.thumbnail}
          alt={`Page ${page.index} raster`}
          className="w-full rounded-md border bg-white object-contain"
        />
        <p className="font-mono text-[10px] text-muted-foreground">
          {page.timingsMs.total} ms · vision {page.timingsMs.vision} ms
          {page.lowDetail && " · low detail"}
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground">Load tray</p>
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <HugeiconsIcon
              icon={SwatchBookIcon}
              className="size-4 text-muted-foreground"
            />
            {page.verdict.recommendedMedia}
          </p>
        </div>
        <InkGauge page={page} />
      </div>

      {!compact && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <FlagChips page={page} />
          </div>
          <p className="text-sm leading-snug text-pretty">
            {page.operatorNotes}
          </p>
          {page.modelWarning && (
            <p className="font-mono text-[10px] text-amber-600">
              {page.modelWarning}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PageRow({ result, page }: { result: JobResult; page: PageResult }) {
  return (
    <li className="rounded-md border p-3">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-heading text-xs font-medium">
            Page {page.index} of {result.pageCount}
          </p>
          <Dimension page={page.page} />
        </div>
        <Badge variant="outline" className="capitalize">
          {page.verdict.documentType}
        </Badge>
      </header>
      <PageBody page={page} />
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <FlagChips page={page} />
        </div>
        <p className="text-sm leading-snug text-pretty">{page.operatorNotes}</p>
        {page.modelWarning && (
          <p className="font-mono text-[10px] text-amber-600">
            {page.modelWarning}
          </p>
        )}
      </div>
    </li>
  )
}

function Pending({
  job,
  onCancel,
}: {
  job: Job
  onCancel?: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border p-4">
      <Skeleton className="size-14 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Badge variant="secondary">
        {job.pages.length > 0 && job.pageCount
          ? `page ${job.pages.length} of ${job.pageCount}`
          : job.status}
      </Badge>
      {job.status === "running" && onCancel && (
        <Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>
          Stop
        </Button>
      )}
    </div>
  )
}

export function JobCard({
  job,
  onRetry,
  onCancel,
}: {
  job: Job
  onRetry?: (id: string) => void
  onCancel?: (id: string) => void
}) {
  if (job.status === "error") {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
        <HugeiconsIcon
          icon={Cancel01Icon}
          className="mt-0.5 size-4 shrink-0 text-destructive"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-heading text-sm font-medium">
            {job.name}
          </p>
          <p className="mt-1 text-sm text-destructive/90">{job.error}</p>
        </div>
        {job.file && onRetry && (
          <Button variant="outline" size="sm" onClick={() => onRetry(job.id)}>
            <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
            Retry
          </Button>
        )}
      </div>
    )
  }

  if (job.status !== "done" || !job.result)
    return <Pending job={job} onCancel={onCancel} />

  const { result } = job
  const lead = result.pages[0]
  const multi = result.pages.length > 1 || result.pageCount > 1
  const mixed = isMixedMedia(result)

  return (
    <article className="rounded-lg border bg-card p-4 text-card-foreground">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-heading text-sm font-medium">
            {job.name}
          </h3>
          <Dimension page={lead.page} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {mixed && (
            <Badge
              variant="outline"
              data-icon="inline-start"
              title="Pages asked for different stock"
            >
              <HugeiconsIcon icon={ArrowUpDownIcon} />
              mixed
            </Badge>
          )}
          <Badge variant="outline" className="capitalize">
            {lead.verdict.documentType}
          </Badge>
        </div>
      </header>

      {result.pagesSkipped > 0 && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {result.pagesSkipped} page{result.pagesSkipped === 1 ? "" : "s"} past
          the per-file cap were not analysed.
        </p>
      )}

      <div className="mt-4">
        <PageBody page={lead} />
      </div>

      {lead.lowDetail && isTextLike(lead.pixels) && (
        <p className="mt-3 text-xs text-muted-foreground">
          Rendered at {lead.thumbPx}px, so type below about 8pt may not be
          legible to the model. Turn on &ldquo;Read small type&rdquo; for small
          print.
        </p>
      )}

      {multi && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-between"
              >
                <span>
                  All {result.pages.length} analysed page
                  {result.pages.length === 1 ? "" : "s"}
                </span>
                <HugeiconsIcon icon={ChevronDownIcon} />
              </Button>
            }
          />
          <CollapsibleContent>
            <ul className="mt-3 flex flex-col gap-3">
              {result.pages.map((p) => (
                <PageRow key={p.index} result={result} page={p} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </article>
  )
}
