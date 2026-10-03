"use client"

import { useMemo, useState } from "react"

import { Dropzone } from "@/components/dropzone"
import { Header } from "@/components/header"
import { JobCard } from "@/components/job-card"
import { TrayFilter } from "@/components/tray-filter"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useJobQueue, isDone } from "@/hooks/use-job-queue"
import { useOllamaHealth, type OllamaHealth } from "@/hooks/use-ollama-health"
import type { MediaStock } from "@/lib/prepress"
import { batchSummary, inTray, trayBreakdown } from "@/lib/summary"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  RefreshIcon,
  TrashIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons"

type Tray = MediaStock | "all"

/** Composition only: state lives in hooks, decisions in lib, markup in parts. */
export function TriageConsole({
  initialHealth,
}: {
  initialHealth: OllamaHealth
}) {
  const { health, poll } = useOllamaHealth(initialHealth)
  const queue = useJobQueue()
  const [tray, setTray] = useState<Tray>("all")

  const results = useMemo(
    () => queue.jobs.filter(isDone).map((j) => j.result),
    [queue.jobs]
  )
  const trays = useMemo(() => trayBreakdown(results), [results])
  const visible = useMemo(
    () =>
      tray === "all"
        ? queue.jobs
        : queue.jobs.filter((j) => !isDone(j) || inTray(j.result, tray)),
    [queue.jobs, tray]
  )

  const pending = queue.jobs.filter(
    (j) => j.status === "queued" || j.status === "running"
  ).length
  const failed = queue.jobs.filter((j) => j.status === "error").length

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <Header health={health} onRecheck={poll} />

      {!health.reachable && (
        <Alert variant="destructive">
          <HugeiconsIcon icon={Upload01Icon} />
          <AlertTitle>Ollama is not answering</AlertTitle>
          <AlertDescription>
            Start it with `ollama serve` and pull {health.model}. Pages still
            rasterise and the ink gauge still works; the vision verdict is
            skipped.
          </AlertDescription>
        </Alert>
      )}

      <Dropzone onFiles={queue.intake} />

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Switch
            id="detail"
            checked={queue.detail}
            onCheckedChange={queue.setDetail}
          />
          <Label htmlFor="detail" className="text-sm">
            Read small type
          </Label>
          <Badge variant="outline" className="font-mono text-[10px]">
            512px
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Detail mode costs about 1.7x the vision time per page.
        </p>

        <div className="ml-auto flex items-center gap-2">
          {failed > 0 && (
            <Button variant="outline" size="sm" onClick={queue.retryFailed}>
              <HugeiconsIcon icon={RefreshIcon} data-icon="inline-start" />
              Retry {failed} failed
            </Button>
          )}
          {pending > 0 && (
            <Button variant="outline" size="sm" onClick={queue.cancelAll}>
              <HugeiconsIcon icon={Cancel01Icon} data-icon="inline-start" />
              Cancel {pending}
            </Button>
          )}
          {results.length > 0 && (
            <Button variant="ghost" size="sm" onClick={queue.clear}>
              <HugeiconsIcon icon={TrashIcon} data-icon="inline-start" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {results.length > 0 && (
        <TrayFilter
          trays={trays}
          total={results.length}
          tray={tray}
          onTrayChange={setTray}
          canCopy
          onCopy={async () => {
            await navigator.clipboard.writeText(batchSummary(results))
          }}
        />
      )}

      <section className="flex flex-col gap-3">
        {visible.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onRetry={queue.retry}
            onCancel={queue.cancel}
          />
        ))}
        {queue.jobs.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing queued. Drop a file to run preflight.
          </p>
        )}
      </section>
    </div>
  )
}
