import os from "node:os"
import { readFileSync } from "node:fs"

import { Ollama } from "ollama"

import { isTextLike } from "./flags"
import { verdictJsonSchema, verdictSchema, type Verdict } from "./prepress"

export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
export const MODEL = process.env.KANTOPRINT_MODEL ?? "gemma4:e2b"

/**
 * Physical cores, not logical ones: llama.cpp gets nothing from SMT siblings
 * and the desktop still has to feel responsive mid-batch. /proc/cpuinfo knows
 * the real core count; elsewhere fall back to half the logical count.
 */
function physicalCores(): number {
  try {
    const pairs = new Set<string>()
    let socket = ""
    for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
      const [key, raw] = line.split(":")
      const value = raw?.trim()
      if (!value) continue
      if (key.trim() === "physical id") socket = value
      else if (key.trim() === "core id") pairs.add(`${socket}/${value}`)
    }
    if (pairs.size > 0) return pairs.size
  } catch {
    // Not Linux, or /proc is unreadable. Fall through.
  }
  return Math.max(2, Math.floor(os.cpus().length / 2))
}

const THREADS = Number(process.env.KANTOPRINT_THREADS ?? physicalCores())

/**
 * A wedged daemon must not hang a request: without this the queue stalls with
 * no error and no way back. The pipeline is serial, so one stuck call blocks
 * every job behind it.
 */
const VISION_TIMEOUT_MS = Number(
  process.env.KANTOPRINT_VISION_TIMEOUT ?? 90_000
)

const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS)
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout
  return fetch(input, { ...init, signal })
}

export const client = new Ollama({ host: OLLAMA_HOST, fetch: timedFetch })

export type Health = {
  reachable: boolean
  modelPresent: boolean
  model: string
  threads: number
  version?: string
  error?: string
}

export async function checkHealth(): Promise<Health> {
  const base = { model: MODEL, threads: THREADS }
  try {
    const [version, list] = await Promise.all([client.version(), client.list()])
    return {
      ...base,
      reachable: true,
      modelPresent: list.models.some(
        (m) => m.model === MODEL || m.name === MODEL
      ),
      version: version.version,
    }
  } catch (err) {
    return {
      ...base,
      reachable: false,
      modelPresent: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const SYSTEM = `You are a prepress triage assistant for desktop inkjet and vinyl cutting.
You get a raster of one page plus measured pixel statistics, and return one JSON verdict.

Measured (trust these over your own read of the image):
mean ink load {{inkLoad}}% | solid dark area {{darkArea}}% | worst 64px tile {{peakTile}}%
edge band {{edgeInk}}% | source transparency {{transparent}}
Ink profile: {{profile}}

Return only these three fields:
- documentType: what the job is. If the type is too small to read in the raster, take the
  job from the ink profile above rather than answering "unknown". Reserve "unknown" for a
  raster you cannot place at all.
- recommendedMedia: stock follows job type first, ink load second.
  text document or form -> 70-80 GSM Bond, or Plain Recycled 100 GSM for sparse text.
  invitation -> 220+ GSM Matte Cardstock. photo -> 240 GSM Matte or Glossy Photo.
  die-cut sticker -> Glossy Vinyl Sticker Sheet, always.
  ink 20-40% -> 220+ GSM Matte Cardstock. ink above 40% -> 300 GSM Photo Board.
  Never answer a heavy-ink page with bond or recycled paper.
  Never put a form on card stock, and never put a sticker on paper.
- hasBleedMargins: true only when ink or a cut line reaches the trim edge.`

/** Facts handed to the model: the same numbers the gauge shows, so the model and
 *  the operator read the same page. */
export type PromptFacts = {
  thumbnail: Buffer
  kind: string
  /** 1-based page being judged. */
  pageIndex: number
  pageCount: number
  sizeLabel: string
  orientation: string
  inkLoad: number
  darkArea: number
  peakTile: number
  edgeInk: number
  transparent: boolean
  profile: string
}

/**
 * At 384px a text page's glyphs are too small to read, so the model gets the
 * shape of the job from the measurements instead of guessing.
 */
export function inkProfile(p: {
  inkLoadPct: number
  darkAreaPct: number
  saturation: number
  hasTransparency: boolean
}): string {
  const mono = p.saturation < 0.12
  if (p.hasTransparency)
    return "die-cut artwork on transparency, expect a sticker"
  if (p.inkLoadPct >= 25 && !mono)
    return "heavy full-coverage colour ink, expect an invitation or photo"
  if (p.inkLoadPct >= 25)
    return "heavy full-coverage ink, expect a photo or solid panel"
  if (isTextLike(p))
    return mono
      ? "sparse monochrome text, expect a document or form"
      : "sparse text and rules, expect a document"
  return "mid-weight mixed content"
}

function userPrompt(f: Omit<PromptFacts, "thumbnail">): string {
  return `Page ${f.pageIndex} of ${f.pageCount}, ${f.kind}, ${f.sizeLabel}, ${f.orientation} orientation. Set up stock and handling flags.`
}

/** One model call. The grammar is the Zod contract, so prose is impossible. */
export async function judgeVerdict(
  args: PromptFacts
): Promise<{ verdict: Verdict; warning: string | null }> {
  const filled = SYSTEM.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    String(
      {
        inkLoad: args.inkLoad,
        darkArea: args.darkArea,
        peakTile: args.peakTile,
        edgeInk: args.edgeInk,
        transparent: args.transparent ? "yes" : "no",
        profile: args.profile,
      }[key] ?? ""
    )
  )

  const messages = [
    { role: "system", content: filled },
    // Gemma 4 wants the image ahead of the text for best multimodal grounding.
    { role: "user", content: userPrompt(args), images: [args.thumbnail] },
  ]

  const options = {
    num_ctx: Number(process.env.KANTOPRINT_CTX ?? 2048),
    num_thread: THREADS,
    temperature: 0,
    seed: 42,
    // Verdict is ~90 tokens. Leave room, do not invite prose.
    num_predict: 160,
  }

  let lastRaw = ""
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await client.chat({
      model: MODEL,
      messages,
      format: verdictJsonSchema,
      // Triage is a classification job, not a reasoning job: thinking doubles
      // turnaround for no gain in the verdict.
      think: false,
      keep_alive: "10m",
      options,
    })

    lastRaw = res.message.content.trim()
    const parsed = verdictSchema.safeParse(parseJson(lastRaw))
    if (parsed.success) {
      return {
        verdict: parsed.data,
        warning:
          attempt === 1
            ? null
            : "First reply failed validation; second attempt used.",
      }
    }
  }

  throw new Error(
    `Model output failed the prepress contract after 2 attempts: ${truncate(lastRaw, 240)}`
  )
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // Grammar violation or a stray think block: salvage the outermost object.
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start === -1 || end <= start)
      throw new SyntaxError("no JSON object in reply")
    return JSON.parse(raw.slice(start, end + 1))
  }
}

const truncate = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n)}…`
