"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { TrayGroup } from "@/lib/summary"
import type { MediaStock } from "@/lib/prepress"
import { HugeiconsIcon } from "@hugeicons/react"
import { Copy01Icon, FilterIcon } from "@hugeicons/core-free-icons"

type Tray = MediaStock | "all"

export function TrayFilter({
  trays,
  total,
  tray,
  onTrayChange,
  onCopy,
  canCopy,
}: {
  trays: TrayGroup[]
  total: number
  tray: Tray
  onTrayChange: (tray: Tray) => void
  onCopy: () => void
  canCopy: boolean
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await onCopy()
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <HugeiconsIcon
        icon={FilterIcon}
        className="size-4 text-muted-foreground"
      />

      <ToggleGroup
        value={[tray]}
        onValueChange={(next) => onTrayChange((next[0] as Tray) ?? "all")}
        variant="outline"
        size="sm"
        className="flex-wrap"
      >
        <ToggleGroupItem value="all">All {total}</ToggleGroupItem>
        {trays.map((t) => (
          <ToggleGroupItem key={t.stock} value={t.stock}>
            {t.stock} {t.count}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Separator orientation="vertical" className="mx-1 h-6" />

      <Button size="sm" variant="outline" onClick={copy} disabled={!canCopy}>
        <HugeiconsIcon icon={Copy01Icon} data-icon="inline-start" />
        {copied ? "Copied" : "Copy batch summary"}
      </Button>
    </div>
  )
}
