# KantoPrint

Air-gapped prepress triage for desktop inkjet and vinyl-cutting workflows. Drop a
PDF or image, get a paper stock, a measured ink gauge, the handling flags that
change how the job runs, and a short operator brief. Nothing leaves the machine:
the only network call is to the local Ollama daemon.

## Requirements

| Piece                              | Why                                                 | Notes                           |
| ---------------------------------- | --------------------------------------------------- | ------------------------------- |
| Ollama with `gemma4:e2b`           | vision + text verdict                               | `ollama pull gemma4:e2b`        |
| `pdftoppm` (poppler-utils) or `gs` | sharp cannot decode PDF                             | page 1 is rasterised at 150 dpi |
| Node 20+                           | runs the fixture script natively via type stripping | Node 26 used here               |

```bash
pnpm install
ollama pull gemma4:e2b      # 4.6 GB
pnpm dev
```

PDF intake fails with a clear message if no rasteriser is installed. Everything
else (PNG, JPEG) only needs sharp.

## Pipeline

```
drop  ->  POST /api/analyze
          A  pdf-lib page boxes / sharp pixel dimensions
          B  rasterise page 1, raw-pixel pass -> ink load, dark area,
             peak 64px tile, edge-band ink, saturation, alpha
          C  384px thumbnail -> Ollama gemma4:e2b, JSON-schema constrained
          D  reconcile measurements over the model verdict, compose the brief
```

`lib/prepress.ts` is the single source of truth. `verdictSchema` is converted to
JSON Schema and handed to Ollama as the `format` grammar, then the reply is
parsed back through the same schema. Model output cannot reach the UI unvalidated;
if the reply misses the contract twice the job fails loudly instead of guessing.

## Layout

`lib/` is pure and framework-free, so the same decisions are made on the server
and in the browser with no second implementation:

| Module         | Responsibility                                                     |
| -------------- | ------------------------------------------------------------------ |
| `prepress.ts`  | schemas, tray stock, ink thresholds. Owns the contract             |
| `raster.ts`    | page metadata and the bounded raster                               |
| `pixels.ts`    | the raw-pixel measurement pass                                     |
| `judge.ts`     | the Ollama call and reply validation                               |
| `preflight.ts` | orchestration and measurement-over-model reconciliation            |
| `flags.ts`     | **the one predicate list**: condition to chip label to instruction |
| `summary.ts`   | tray breakdown and the paste-ready batch sheet                     |

`flags.ts` is the load-bearing one. The card renders `label` as chips and the
pipeline renders `instruction` into `operatorNotes` from the same array, so a flag
cannot appear on the card and go missing from the brief. Adding a condition means
editing one function, not two.

`hooks/use-job-queue.ts` owns the intake queue and its serial drain;
`hooks/use-ollama-health.ts` owns polling. `triage-console.tsx` composes
`Header`, `Dropzone`, `TrayFilter`, and `JobCard` and holds no logic of its own.

## What the model decides, and what it does not

`gemma4:e2b` is a 2B edge model. It is good at "what job is this and what should
I load" and unreliable at anything a pixel pass can prove. Measured on this
workstation (i5-1235U, 10 threads), it called a wide-margin contract "bleeding"
and a full-bleed invitation "safe". So `lib/preflight.ts` reconciles:

| Field              | Owner    | Rule                                                |
| ------------------ | -------- | --------------------------------------------------- |
| `documentType`     | model    | alpha + a vinyl choice pins `sticker`               |
| `recommendedMedia` | model    | `sticker` pins vinyl; enum of 7 tray stocks         |
| `inkRiskLevel`     | both     | measured risk wins when it is higher                |
| `hasBleedMargins`  | pixels   | edge ink >= 5% is bleeding, <= 0.5% is provably not |
| `needsRotation`    | geometry | landscape page on a portrait feed                   |
| `operatorNotes`    | pixels   | composed from the flags, not model prose            |

`operatorNotes` and `needsRotation` were in the original model contract. Both
were removed after measuring: the model answered "Set up the material for
printing", and they cost roughly 30 of the ~55 generated tokens per job.

Ink risk escalates only. If the model says `medium` on a job the gauge calls
`low`, the card keeps `medium`: over-warning is the cheaper failure on a shop
floor.

## Measured performance

10 physical cores, `gemma4:e2b`, 384px thumbnails, model kept resident via
`keep_alive`:

| Stage                             | Time      |
| --------------------------------- | --------- |
| Raster + metadata                 | 60-170 ms |
| Pixel pass                        | 25-55 ms  |
| Vision call (warm)                | 3.7-4.4 s |
| First job after a cold model load | 14-32 s   |

Vision dominates and scales with input pixels, so thumbnail size is the main
lever. At 256px the model stops recognising artwork ("unknown" on a badge); at
384px it classifies all three fixtures correctly at roughly half the encode cost
of 512px. Output token count is the second lever, hence the 4-field schema.

Warm turnaround sits at 3.7-4.4 s, so the 4 s target is met on the median and
missed at the tail. Cold loads cost 14-32 s, and an occasional 15-18 s outlier
shows up mid-batch when the vision encode lands on a cold mapping — the model is
the floor here, not the app code.

## Configuration

| Variable             | Default                  | Notes                                   |
| -------------------- | ------------------------ | --------------------------------------- |
| `OLLAMA_HOST`        | `http://127.0.0.1:11434` |                                         |
| `KANTOPRINT_MODEL`   | `gemma4:e2b`             |                                         |
| `KANTOPRINT_THREADS` | physical core count      | read from `/proc/cpuinfo`               |
| `KANTOPRINT_CTX`     | `2048`                   | 8192 measured no better and much slower |
| `KANTOPRINT_DPI`     | `150`                    | raster DPI for PDF pages                |
| `KANTOPRINT_THUMB`   | `384`                    | vision input size                       |

## Fixtures

```bash
pnpm fixtures
```

Deterministic, no timestamps or randomness, so a verdict diff means a regression:

| File                              | Case                                         |
| --------------------------------- | -------------------------------------------- |
| `01-contract-low-ink.pdf`         | Letter, sparse monochrome text, wide margins |
| `02-invitation-heavy-ink.pdf`     | 5x7, full-bleed colour panels, 48% ink       |
| `03-badge-sticker-zero-bleed.png` | die-cut circle flush with the trim           |

## API

- `POST /api/analyze` — one `file` per request, multipart. Sniffs magic bytes,
  rejects anything over 25 MB. 422 with a reason on failure.
- `GET /api/health` — Ollama reachability, whether the model is pulled, thread
  count. 503 when the daemon is down, which the header badge reflects.

## Tooling

| Task          | Command             | Tool                          |
| ------------- | ------------------- | ----------------------------- |
| Lint          | `pnpm lint`         | oxlint 1.86, `.oxlintrc.json` |
| Lint, autofix | `pnpm lint:fix`     |                               |
| Format        | `pnpm format`       | oxfmt, `.oxfmtrc.json`        |
| Format check  | `pnpm format:check` |                               |
| Types         | `pnpm typecheck`    | tsc                           |

`@shadcn/lint` is registered as an oxlint JS plugin and is configured with no
rules enabled. It discovers components, variants, and the theme through
`components.json`, so rules work as soon as you turn them on:

```jsonc
// .oxlintrc.json
"rules": {
  "shadcn/no-restyle": ["error", { "allow": ["layout"] }],
  "shadcn/no-arbitrary-values": "error"
}
```

Rule list: <https://github.com/shadcn-ui/lint#rules>. Config examples:
<https://github.com/shadcn-ui/lint/blob/main/docs/design-systems.md>.

`components/ui/**` and `app/globals.css` are excluded from lint and format.
Those are regenerated by `npx shadcn add`, so fixes there get overwritten and
their findings are noise. Remove the `ignorePatterns` entry to include them.

## Known gaps

- Multi-page PDFs analyse page 1 only; the card says `page 1 of N`.
