"use client"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { OllamaHealth } from "@/hooks/use-ollama-health"
import { HugeiconsIcon } from "@hugeicons/react"
import { PrinterIcon, RefreshIcon } from "@hugeicons/core-free-icons"

function status(health: OllamaHealth) {
  if (!health.reachable)
    return { label: "ollama offline", variant: "destructive" as const }
  if (!health.modelPresent)
    return {
      label: `${health.model} not pulled`,
      variant: "destructive" as const,
    }
  return {
    label: `${health.model} · ${health.threads} threads`,
    variant: "secondary" as const,
  }
}

export function Header({
  health,
  onRecheck,
}: {
  health: OllamaHealth
  onRecheck: () => void
}) {
  const { label, variant } = status(health)

  return (
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
        <Badge variant={variant} data-icon="inline-start">
          <span className="size-1.5 rounded-full bg-current" />
          {label}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRecheck}
          aria-label="Recheck Ollama"
        >
          <HugeiconsIcon icon={RefreshIcon} />
        </Button>
      </div>
    </header>
  )
}
