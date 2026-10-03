"use client"

import { useCallback, useEffect, useState } from "react"

export type OllamaHealth = {
  reachable: boolean
  modelPresent: boolean
  model: string
  threads: number
  error?: string
}

const OFFLINE: OllamaHealth = {
  reachable: false,
  modelPresent: false,
  model: "-",
  threads: 0,
}

const POLL_MS = 30_000

/**
 * Probes `/api/health`, which the page already called once on the server, so
 * this only subscribes. Returns the probe as well: the header button reuses it.
 */
export function useOllamaHealth(initial: OllamaHealth) {
  const [health, setHealth] = useState(initial)

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" })
      setHealth(await res.json())
    } catch {
      setHealth(OFFLINE)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(poll, POLL_MS)
    return () => clearInterval(id)
  }, [poll])

  return { health, poll }
}
