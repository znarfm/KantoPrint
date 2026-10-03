"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { JobCard, type Job } from "@/components/job-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { MEDIA_STOCKS, type JobResult, type MediaStock } from "@/lib/prepress"
import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Copy01Icon,
  FilterIcon,
  PrinterIcon,
  RefreshIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons"

type Health = {
  reachable: boolean
  modelPresent: boolean
  model: string
  threads: number
  error?: string
}

let seq = 0
const nextId = () => `job-${++seq}`

export function TriageConsole({ initialHealth }: { initialHealth: Health }) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [health, setHealth] = useState<Health>(initialHealth)
  const [tray, setTray] = useState<MediaStock | "all">("all")
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  // The local model is the bottleneck: one file at a time, no overlap.
  const running = useRef(false)

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" })
      setHealth(await res.json())
    } catch {
      setHealth({
        reachable: false,
        modelPresent: false,
        model: "-",
        threads: 0,
      })
    }
  }, [])

  // Subscription only. The first probe already happened on the server.
  useEffect(() => {
    const id = setInterval(poll, 30_000)
    return () => clearInterval(id)
  }, [poll])

  const patch = (id: string, next: Partial<Job>) =>
    setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...next } : j)))

  const analyze = useCallback(async (job: Job) => {
    patch(job.id, { status: "running" })
    try {
      const form = new FormData()
      form.append("file", job.file)
      const res = await fetch("/api/analyze", { method: "POST", body: form })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      patch(job.id, { status: "done", result: body.result })
    } catch (err) {
      patch(job.id, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [])

  const intake = useCallback(
    (files: FileList | File[]) => {
      const queue: Job[] = Array.from(files).map((file) => ({
        id: nextId(),
        name: file.name,
        bytes: file.size,
        file,
        status: "queued",
      }))
      if (queue.length === 0) return
      setBusy(true)
      setJobs((all) => [...all, ...queue])
      // Drain serially: two concurrent vision calls on one CPU just thrash.
      void (async () => {
        if (running.current) return
        running.current = true
        try {
          for (const job of queue) await analyze(job)
        } finally {
          running.current = false
          setBusy(false)
        }
      })()
    },
    [analyze]
  )

  const done = useMemo(
    () =>
      jobs.filter(
        (j): j is Job & { result: JobResult } =>
          j.status === "done" && j.result !== undefined
      ),
    [jobs]
  )

  const trays = useMemo(() => {
    const used = new Map<MediaStock, number>()
    for (const j of done) {
      const m = j.result.verdict.recommendedMedia
      used.set(m, (used.get(m) ?? 0) + 1)
    }
    return MEDIA_STOCKS.map((m) => ({
      stock: m,
      count: used.get(m) ?? 0,
    })).filter((t) => t.count > 0)
  }, [done])

  const visible =
    tray === "all"
      ? jobs
      : jobs.filter(
          (j) =>
            j.status !== "done" || j.result?.verdict.recommendedMedia === tray
        )

  const summary = useMemo(() => {
    if (done.length === 0) return ""
    const lines = trays.map((t) => {
      const members = done.filter(
        (j) => j.result.verdict.recommendedMedia === t.stock
      )
      const flags = members.flatMap((j) => {
        const v = j.result.verdict
        const f: string[] = []
        if (v.inkRiskLevel !== "low") f.push(`${v.inkRiskLevel} ink`)
        if (v.hasBleedMargins) f.push("at trim")
        if (j.result.needsRotation) f.push("rotate")
        return f.map((x) => `${j.name} (${x})`)
      })
      const head = `${t.stock} x${t.count}`
      return flags.length > 0 ? `${head}\n  ${flags.join("\n  ")}` : head
    })
    return `KantoPrint batch: ${done.length} job(s)\n\n${lines.join("\n\n")}`
  }, [done, trays])

  const copy = async () => {
    await navigator.clipboard.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <HugeiconsIcon icon={PrinterIcon} className="size-6 text-primary" />
          <div>
            <h1 className="font-heading text-lg font-semibold">KantoPrint</h1>
            <p className="text-xs text-muted-foreground">
              Air-gapped prepress triage
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            data-icon="inline-start"
            className={cn(
              health.reachable &&
                health.modelPresent &&
                "text-emerald-600 dark:text-emerald-400",
              !health.reachable || !health.modelPresent
                ? "text-destructive"
                : ""
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {!health.reachable
              ? "ollama offline"
              : health.modelPresent
                ? `${health.model} · ${health.threads} threads`
                : `${health.model} not pulled`}
          </Badge>
          <Button
            variant="ghost"
            size="icon"
            onClick={poll}
            aria-label="Recheck Ollama"
          >
            <HugeiconsIcon icon={RefreshIcon} />
          </Button>
        </div>
      </header>

      {health && !health.reachable && (
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

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          intake(e.dataTransfer.files)
        }}
        onClick={() => input.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:bg-muted/40"
        )}
      >
        <HugeiconsIcon
          icon={Upload01Icon}
          className="size-7 text-muted-foreground"
        />
        <p className="text-sm font-medium">Drop PDFs, PNGs or JPEGs here</p>
        <p className="text-xs text-muted-foreground">
          Batch up to a full tray run. Files are never uploaded off this
          machine.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) intake(e.target.files)
            e.target.value = ""
          }}
        />
      </div>

      {done.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <HugeiconsIcon
            icon={FilterIcon}
            className="size-4 text-muted-foreground"
          />
          <Button
            size="sm"
            variant={tray === "all" ? "default" : "ghost"}
            onClick={() => setTray("all")}
          >
            All {done.length}
          </Button>
          {trays.map((t) => (
            <Button
              key={t.stock}
              size="sm"
              variant={tray === t.stock ? "default" : "ghost"}
              onClick={() => setTray(t.stock)}
            >
              {t.stock} {t.count}
            </Button>
          ))}
          <Separator orientation="vertical" className="mx-1 h-6" />
          <Button size="sm" variant="outline" onClick={copy}>
            <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
            {copied ? "Copied" : "Copy batch summary"}
          </Button>
        </div>
      )}

      <section className="flex flex-col gap-3">
        {busy && (
          <p className="font-mono text-xs text-muted-foreground">
            triaging{" "}
            {
              jobs.filter((j) => j.status !== "done" && j.status !== "error")
                .length
            }{" "}
            remaining, one at a time
          </p>
        )}
        {visible.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
        {jobs.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing queued. Drop a file to run preflight.
          </p>
        )}
      </section>
    </div>
  )
}
