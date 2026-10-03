"use client"

import { useCallback, useRef, useState } from "react"

import type { JobResult } from "@/lib/prepress"

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

export type DoneJob = Job & { status: "done"; result: JobResult }

export const isDone = (job: Job): job is DoneJob =>
  job.status === "done" && job.result !== undefined

let seq = 0

/**
 * Intake queue for the local model. Files drain strictly one at a time: two
 * concurrent vision calls on one CPU do not overlap, they just thrash.
 */
export function useJobQueue() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [busy, setBusy] = useState(false)
  const draining = useRef(false)

  const patch = useCallback((id: string, next: Partial<Job>) => {
    setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...next } : j)))
  }, [])

  const intake = useCallback(
    (files: FileList | File[]) => {
      const queue: Job[] = Array.from(files).map((file) => ({
        id: `job-${++seq}`,
        name: file.name,
        bytes: file.size,
        file,
        status: "queued",
      }))
      if (queue.length === 0) return

      setJobs((all) => [...all, ...queue])
      setBusy(true)

      if (draining.current) return
      draining.current = true

      void (async () => {
        try {
          for (const job of queue) {
            patch(job.id, { status: "running" })
            try {
              const form = new FormData()
              form.append("file", job.file)
              const res = await fetch("/api/analyze", {
                method: "POST",
                body: form,
              })
              const body = await res.json()
              if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
              patch(job.id, { status: "done", result: body.result })
            } catch (err) {
              patch(job.id, {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        } finally {
          draining.current = false
          setBusy(false)
        }
      })()
    },
    [patch]
  )

  return { jobs, busy, intake }
}
