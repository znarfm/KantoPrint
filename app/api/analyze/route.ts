import { ingest, runPreflight } from "@/lib/preflight"
import { jobResultSchema } from "@/lib/prepress"

export const runtime = "nodejs"

/**
 * One file per request. The client walks a batch, so a poison file fails its
 * own card instead of the whole run.
 */
export async function POST(request: Request) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with a `file` field." },
      { status: 400 }
    )
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return Response.json({ error: "Missing `file` field." }, { status: 400 })
  }

  try {
    const result = await runPreflight(await ingest(file))
    const checked = jobResultSchema.safeParse(result)
    if (!checked.success) {
      // Server-side contract break: never hand the UI something unvalidated.
      return Response.json(
        { error: `Response contract violated: ${checked.error.message}` },
        { status: 500 }
      )
    }
    return Response.json({ result: checked.data })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 422 })
  }
}
