import { AbortedError, ingest, runPreflight } from "@/lib/preflight"
import { pageResultSchema } from "@/lib/prepress"

export const runtime = "nodejs"

/**
 * Newline-delimited JSON, one line per analysed page, so a long PDF reports
 * progress instead of holding the card silent for a minute. Validated per line:
 * a contract violation on page 7 must not be able to ship pages 1-6 unvalidated.
 */
const NDJSON = "application/x-ndjson"

type Wire =
  | { type: "page"; page: unknown }
  | { type: "done"; pageCount: number; pagesSkipped: number; totalMs: number }
  | { type: "error"; error: string }

function ndjson(line: Wire): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(line)}\n`)
}

/**
 * One file per request. The client walks a batch, so a poison file fails its
 * own card instead of the whole run.
 */
export async function POST(request: Request) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return json(
      {
        type: "error",
        error: "Expected multipart/form-data with a `file` field.",
      },
      400
    )
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return json({ type: "error", error: "Missing `file` field." }, 400)
  }

  const detail = form.get("detail") === "high"

  // Ingest failures happen before any streaming starts, so they can still be a
  // plain JSON response and keep a simple status code.
  let input: Awaited<ReturnType<typeof ingest>>
  try {
    input = await ingest(file)
  } catch (err) {
    return json(
      {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      422
    )
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: Wire) => controller.enqueue(ndjson(line))
      try {
        const summary = await runPreflight({
          ...input,
          detail,
          signal: request.signal,
          onPage: (page) => {
            send({ type: "page", page: pageResultSchema.parse(page) })
          },
        })
        send({
          type: "done",
          pageCount: summary.pageCount,
          pagesSkipped: summary.pagesSkipped,
          totalMs: summary.timingsMsTotal,
        })
      } catch (err) {
        // A cancelled request has nowhere left to send the error.
        if (err instanceof AbortedError || request.signal.aborted) {
          controller.close()
          return
        }
        send({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": NDJSON,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  })
}

function json(body: unknown, status: number) {
  return Response.json(body, { status })
}
