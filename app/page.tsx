import { TriageConsole } from "@/components/triage-console"
import { checkHealth } from "@/lib/judge"

/** Ollama is probed per request: a baked-in build-time answer is worthless. */
export const dynamic = "force-dynamic"

export default async function Page() {
  // Probed here so the status badge is right on first paint. The client keeps
  // it fresh with a subscription rather than a fetch-on-mount effect.
  const health = await checkHealth()
  return <TriageConsole initialHealth={health} />
}
