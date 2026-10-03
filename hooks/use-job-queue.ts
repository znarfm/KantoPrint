"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  jobResultSchema,
  type JobResult,
  type PageResult,
} from "@/lib/prepress"

export type JobStatus = "queued" | "running" | "done" | "error" | "cancelled"

export type Job = {
  id: string
  name: string
  bytes: number
  mimeType: string
  /** Absent after a reload: a File cannot be persisted, so retry needs a re-drop. */
  file?: File
  status: JobStatus
  /** Pages that have finished, in arrival order. Fills in while running. */
  pages: PageResult[]
  pageCount?: number
  pagesSkipped?: number
  totalMs?: number
  result?: JobResult
  error?: string
}

export type DoneJob = Job & { status: "done"; result: JobResult }

export const isDone = (job: Job): job is DoneJob =>
  job.status === "done" && job.result !== undefined

const STORAGE_KEY = "kantoprint.batch.v1"
/** Thumbnails are base64 PNGs, so the quota goes fast. Keep the recent tail. */
const PERSIST_LIMIT = 12

let seq = 0

type Wire =
  | { type: "page"; page: unknown }
  | { type: "done"; pageCount: number; pagesSkipped: number; totalMs: number }
  | { type: "error"; error: string }

/** Yield NDJSON lines as the response body delivers them. */
async function* readNdjson(res: Response): AsyncGenerator<Wire> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error("Response had no body.")
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) yield JSON.parse(line) as Wire
    }
  }
}

/**
 * Intake queue for the local model. Files drain strictly one at a time: two
 * concurrent vision calls on one CPU do not overlap, they thrash.
 *
 * Done jobs are persisted so a refresh does not lose a tray run. The File is
 * not serialisable, so a restored job can be read and copied but not retried.
 */
export function useJobQueue() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [detail, setDetail] = useState(false)

  // Side effects read these instead of reaching into state inside an updater.
  const jobsRef = useRef<Job[]>([])
  const inflight = useRef(new Map<string, AbortController>())
  const cancelledIds = useRef(new Set<string>())

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  const patch = useCallback((id: string, next: Partial<Job>) => {
    setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...next } : j)))
  }, [])

  // Rehydrate on mount: verdicts survive, files do not. localStorage does not
  // exist during SSR, so this cannot be a lazy initialiser without a hydration
  // mismatch; one extra render after mount is the cheaper trade.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Job[]
      if (!Array.isArray(saved)) return
      // oxlint-disable-next-line react/set-state-in-effect
      setJobs((all) => [
        ...all,
        ...saved.map((j) => ({
          ...j,
          file: undefined,
          status: "done" as const,
        })),
      ])
    } catch {
      // Corrupt or unavailable storage is not worth failing the app over.
    }
  }, [])

  useEffect(() => {
    const done = jobs.filter(isDone).slice(-PERSIST_LIMIT)
    if (done.length === 0) return
    const write = (payload: string) =>
      localStorage.setItem(STORAGE_KEY, payload)
    try {
      write(JSON.stringify(done))
    } catch {
      // Quota exceeded: keep the verdicts, drop the thumbnail payload.
      try {
        write(
          JSON.stringify(
            done.map((j) => ({
              ...j,
              result: {
                ...j.result,
                pages: j.result.pages.map((p) => ({ ...p, thumbnail: "" })),
              },
            }))
          )
        )
      } catch {
        // Give up quietly: the queue still works, it just will not survive reload.
      }
    }
  }, [jobs])

  const run = useCallback(
    async (job: Job) => {
      if (!job.file || inflight.current.has(job.id)) return
      const controller = new AbortController()
      inflight.current.set(job.id, controller)
      patch(job.id, { status: "running", pages: [], error: undefined })

      const pages: PageResult[] = []
      let settled = false
      try {
        const form = new FormData()
        form.append("file", job.file)
        if (detail) form.append("detail", "high")

        const res = await fetch("/api/analyze", {
          method: "POST",
          body: form,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(await errorFrom(res))

        for await (const line of readNdjson(res)) {
          if (line.type === "page") {
            pages.push(line.page as PageResult)
            patch(job.id, {
              pages: [...pages],
              pageCount: pages[0]?.page.pageCount,
            })
          } else if (line.type === "done") {
            // Client-side parse too: the server validated each page, but the
            // assembled job is what the UI reads, so it gets checked as well.
            const result = jobResultSchema.parse({
              fileName: job.name,
              byteSize: job.bytes,
              mimeType: job.mimeType,
              pageCount: line.pageCount,
              pages,
              pagesSkipped: line.pagesSkipped,
              timingsMs: { total: line.totalMs },
            })
            settled = true
            patch(job.id, {
              status: "done",
              result,
              pagesSkipped: line.pagesSkipped,
              totalMs: line.totalMs,
            })
          } else {
            throw new Error(line.error)
          }
        }
        // Stream ended without a done line: the connection dropped mid-file.
        if (!settled) throw new Error("Stream ended before the last page.")
      } catch (err) {
        const aborted = controller.signal.aborted
        patch(job.id, {
          status: aborted ? "cancelled" : "error",
          pages: [],
          error: aborted ? "Cancelled." : messageOf(err),
        })
      } finally {
        inflight.current.delete(job.id)
      }
    },
    [detail, patch]
  )

  const drain = useCallback(
    (queue: Job[]) => {
      void (async () => {
        for (const job of queue) {
          // The operator may cancel work that has not started yet.
          if (cancelledIds.current.has(job.id)) continue
          await run(job)
        }
      })()
    },
    [run]
  )

  const intake = useCallback(
    (files: FileList | File[]) => {
      const queue: Job[] = Array.from(files).map((file) => ({
        id: `job-${++seq}`,
        name: file.name,
        bytes: file.size,
        mimeType: file.type,
        file,
        status: "queued",
        pages: [],
      }))
      if (queue.length === 0) return
      setJobs((all) => [...all, ...queue])
      drain(queue)
    },
    [drain]
  )

  const retry = useCallback(
    (id: string) => {
      cancelledIds.current.delete(id)
      const job = jobsRef.current.find((j) => j.id === id)
      if (job) void run(job)
    },
    [run]
  )

  const retryFailed = useCallback(() => {
    for (const job of jobsRef.current) {
      if (job.status === "error" && job.file) void run(job)
    }
  }, [run])

  const cancel = useCallback((id: string) => {
    cancelledIds.current.add(id)
    inflight.current.get(id)?.abort()
  }, [])

  const cancelAll = useCallback(() => {
    for (const job of jobsRef.current) {
      if (job.status === "queued" || job.status === "running") cancel(job.id)
    }
  }, [cancel])

  const clear = useCallback(() => {
    cancelAll()
    setJobs([])
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }, [cancelAll])

  const busy = jobs.some((j) => j.status === "queued" || j.status === "running")

  return {
    jobs,
    busy,
    detail,
    setDetail,
    intake,
    retry,
    retryFailed,
    cancel,
    cancelAll,
    clear,
  }
}

async function errorFrom(res: Response): Promise<string> {
  try {
    const body = await res.json()
    return body?.error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err)
