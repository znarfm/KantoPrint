import { checkHealth } from "@/lib/judge"

export const runtime = "nodejs"
/** Live daemon probe, never cached. */
export const dynamic = "force-dynamic"

export async function GET() {
  const health = await checkHealth()
  return Response.json(health, { status: health.reachable ? 200 : 503 })
}
