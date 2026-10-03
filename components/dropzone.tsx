"use client"

import { useRef, useState } from "react"

import { cn } from "cn"
import { HugeiconsIcon } from "@hugeicons/react"
import { Upload01Icon } from "@hugeicons/core-free-icons"

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"

/** Owns its own drag state, so the console stays a composition of pieces. */
export function Dropzone({ onFiles }: { onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  return (
    <button
      type="button"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        onFiles(e.dataTransfer.files)
      }}
      onClick={() => input.current?.click()}
      className={cn(
        "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
        dragging
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40"
      )}
    >
      <HugeiconsIcon
        icon={Upload01Icon}
        className="size-7 text-muted-foreground"
      />
      <p className="text-sm font-medium">Drop PDFs, PNGs or JPEGs here</p>
      <p className="text-xs text-muted-foreground">
        Batch up to a full tray run. Files are never uploaded off this machine.
      </p>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) onFiles(e.target.files)
          e.target.value = ""
        }}
      />
    </button>
  )
}
