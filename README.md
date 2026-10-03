# KantoPrint

Air-gapped prepress triage for desktop inkjet and vinyl-cutting workflows. Drop a
PDF or image, get a paper stock, a measured ink gauge, the handling flags that
change how the job runs, and a short operator brief. Every page of a PDF is
analysed. Nothing leaves the machine: the only network call is to the local Ollama
daemon.

## Requirements

| Piece                              | Why                                                 | Notes                    |
| ---------------------------------- | --------------------------------------------------- | ------------------------ |
| Ollama with `gemma4:e2b`           | vision + text verdict                               | `ollama pull gemma4:e2b` |
| `pdftoppm` (poppler-utils) or `gs` | sharp cannot decode PDF                             | every page, at 150 dpi   |
| Node 20+                           | runs the fixture script natively via type stripping | Node 26 used here        |

```bash
pnpm install
ollama pull gemma4:e2b      # 4.6 GB
pnpm fixtures               # deterministic test assets
pnpm dev
```

PDF intake fails with a clear message if no rasteriser is installed. Everything
else (PNG, JPEG) only needs sharp.

## Pipeline

```
drop  ->  POST /api/analyze   (NDJSON, one line per page as it finishes)
          A  pdf-lib page boxes / sharp pixel dimensions, every page
          B  rasterise, raw-pixel pass -> ink load, dark area,
             peak 64px tile, edge-band ink, saturation, alpha
          C  384px thumbnail -> Ollama gemma4:e2b, JSON-schema constrained
          D  reconcile measurements over the model verdict, compose the brief
```

The response streams, so a 20-page PDF fills the card in as it goes instead of
going quiet for five minutes. The client can abort between pages and the server
stops: the request signal is checked before each page, and the temp directory is
removed either way.

`lib/prepress.ts` is the single source of truth. `verdictSchema` is converted to
JSON Schema and handed to Ollama as the `format` grammar, then the reply is
parsed back through the same schema. It is a `strictObject`: a field the schema
does not declare is an error, not something to strip quietly. Nothing
model-authored reaches the UI unvalidated.

## What the model decides, and what it does not

`gemma4:e2b` is a 2B edge model. It is good at "what job is this and what should
I load" and unreliable at anything a pixel pass can prove. Measured on this
workstation, it called a wide-margin contract "bleeding" and a full-bleed
invitation "safe", and it put a 0.9% ink form on "medium" risk next to a gauge
reading 0.9%. So `lib/preflight.ts` reconciles:

| Field              | Owner    | Rule                                                |
| ------------------ | -------- | --------------------------------------------------- |
| `documentType`     | model    | alpha + a vinyl choice pins `sticker`               |
| `recommendedMedia` | model    | `sticker` pins vinyl; enum of 7 tray stocks         |
| `hasBleedMargins`  | pixels   | edge ink >= 5% is bleeding, <= 0.5% is provably not |
| `inkRiskLevel`     | pixels   | measured outright, 10% / 22% thresholds             |
| `needsRotation`    | geometry | landscape page on a portrait feed                   |
| `operatorNotes`    | pixels   | composed from the flags, not model prose            |

`inkRiskLevel`, `needsRotation` and `operatorNotes` were in the original model
contract. All three were removed after measuring: they disagreed with the
numbers printed beside them, and cost roughly 40 of the ~55 generated tokens per
page. The model now returns three fields.

## Measured performance

10 physical cores, `gemma4:e2b`, 384px thumbnails, production build:

| Stage                               | Time      |
| ----------------------------------- | --------- |
| Raster + metadata, whole file       | 0.1-0.3 s |
| Pixel pass, per page                | 25-55 ms  |
| Vision, first time an image is seen | 11-17 s   |
| Vision, same image seen again       | 1.6-3.2 s |
| Vision, cold model load             | 14-32 s   |

The gap between the third and fourth rows is not noise: Ollama caches the vision
encoder output per image, so re-running the same file is roughly 5x faster than
seeing a new one. In real use every file is new, so **plan on 11-17 s per page**,
not the 3-4 s a repeat run reports. Earlier revisions of this file quoted the
cached figure; that was wrong.

A 20-page PDF is therefore 4-6 minutes. That is why the response streams, why the
per-file page cap exists, and why Stop is on the card.

Two levers, both measured:

- **Thumbnail size.** Encode cost scales with input pixels. At 256px the model
  stops recognising artwork; 384px classifies correctly; 512px costs about 1.7x
  more and only helps when you need small type, so it is behind the "Read small
  type" switch rather than on by default.
- **Output tokens.** Already cut roughly 70% by shrinking the schema.

At 384px an 11pt line on Letter is about 4.6px tall, so the model cannot read
body text. The card says so on text pages. Job _classification_ still works,
because the prompt carries the measured ink profile and the model is told to
trust it over its own read of an unreadable raster.

## Layout

`lib/` is pure and framework-free, so the same decisions are made on the server
and in the browser with no second implementation:

| Module         | Responsibility                                                     |
| -------------- | ------------------------------------------------------------------ |
| `prepress.ts`  | schemas, tray stock, ink thresholds. Owns the contract             |
| `raster.ts`    | page metadata, the bounded raster, child-process timeouts          |
| `pixels.ts`    | the raw-pixel measurement pass                                     |
| `judge.ts`     | the Ollama call, reply validation, vision timeout                  |
| `preflight.ts` | per-page orchestration and measurement-over-model reconciliation   |
| `flags.ts`     | **the one predicate list**: condition to chip label to instruction |
| `summary.ts`   | tray breakdown and the paste-ready batch sheet                     |

`flags.ts` is the load-bearing one. The card renders `label` as chips, the
pipeline renders `instruction` into `operatorNotes`, and the batch sheet renders
`label` again — all from the same array, so a flag cannot appear in one place and
go missing from another. Adding a condition means editing one function.

`hooks/use-job-queue.ts` owns intake, the serial drain, streaming NDJSON, abort,
retry and persistence. `hooks/use-ollama-health.ts` owns polling. The console
composes `Header`, `Dropzone`, `TrayFilter` and `JobCard` and holds no logic.

A file is filed under one tray even when its pages disagree: `dominantMedia`
takes the majority, ties go to page 1, and the card is badged `mixed` so the
operator knows.

## Tooling

| Task          | Command             | Tool                          |
| ------------- | ------------------- | ----------------------------- |
| Lint          | `pnpm lint`         | oxlint 1.86, `.oxlintrc.json` |
| Lint, autofix | `pnpm lint:fix`     |                               |
| Format        | `pnpm format`       | oxfmt, `.oxfmtrc.json`        |
| Format check  | `pnpm format:check` |                               |
| Types         | `pnpm typecheck`    | tsc                           |
| Unit tests    | `pnpm test`         | vitest                        |
| Model tests   | `pnpm test:model`   | needs a pulled model          |
| Build         | `pnpm build`        |                               |

`.oxfmtrc.json` came from `oxfmt --migrate=prettier` and keeps `semi: false`,
`printWidth: 80` and tailwind class sorting.

`@shadcn/lint` is registered as an oxlint JS plugin with **no rules enabled**.
Component and theme discovery run through `components.json`, so rules work as
soon as you turn them on:

```jsonc
// .oxlintrc.json
"rules": {
  "shadcn/no-restyle": ["error", { "allow": ["layout"] }],
  "shadcn/no-arbitrary-values": "error"
}
```

Rule list: <https://github.com/shadcn-ui/lint#rules>.

`components/ui/**` and `app/globals.css` are excluded from lint and format. Those
are regenerated by `npx shadcn add`, so findings there are noise and fixes get
overwritten. Remove the `ignorePatterns` entry to include them.

## Tests

60 unit tests over the pure layer: the schema contract, ink thresholds, the pixel
pass against synthetic images with known coverage, `reconcile`, the flag list, the
tray grouping and the batch sheet. No model, no daemon, no network.

```bash
pnpm test          # 60 tests, ~0.3s
pnpm test:model    # opt-in: drives the real daemon against the fixtures
```

`pnpm test:model` is the only place the acceptance criteria are asserted — every
reply parses, every page finishes inside a budget, all pages of a PDF are
analysed, and aborting mid-document stops the work. It is excluded from `pnpm test`
because CI has no Ollama.

CI (`.github/workflows/ci.yml`) runs lint, format check, types, unit tests and
build on every push.

## Configuration

Every variable has a working default; see `.env.example`.

| Variable                    | Default                  | Notes                                        |
| --------------------------- | ------------------------ | -------------------------------------------- |
| `OLLAMA_HOST`               | `http://127.0.0.1:11434` |                                              |
| `KANTOPRINT_MODEL`          | `gemma4:e2b`             |                                              |
| `KANTOPRINT_THREADS`        | physical core count      | read from `/proc/cpuinfo`                    |
| `KANTOPRINT_CTX`            | `2048`                   | 8192 measured no better and much slower      |
| `KANTOPRINT_THUMB`          | `384`                    | vision input size                            |
| `KANTOPRINT_THUMB_DETAIL`   | `512`                    | behind "Read small type"                     |
| `KANTOPRINT_DPI`            | `150`                    | raster DPI; the edge band is derived from it |
| `KANTOPRINT_MAX_PAGES`      | `20`                     | pages analysed per file                      |
| `KANTOPRINT_RASTER_TIMEOUT` | `45000`                  | hard cap on `pdftoppm` / `gs`                |
| `KANTOPRINT_VISION_TIMEOUT` | `90000`                  | hard cap on one vision call                  |

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

- `POST /api/analyze` — one `file` per request, multipart. Optional
  `detail=high`. Magic bytes decide the type; the browser's MIME is not trusted,
  because there is no accepted format without a recognisable signature. Responds
  `application/x-ndjson` with one `page` line per analysed page, then a `done`
  line, or a single JSON error before streaming starts.
- `GET /api/health` — Ollama reachability, whether the model is pulled, thread
  count. 503 when the daemon is down, which the header badge reflects.

## Known gaps

- The 4 s-per-file target in the original plan is not met. A fresh page costs
  11-17 s of CPU vision; see the performance table.
- Multi-page PDFs stop at `KANTOPRINT_MAX_PAGES` and the card says how many pages
  were skipped. There is no way to analyse pages 21-40 without splitting the file.
- Small print is only legible in detail mode, and detail mode is a global switch
  rather than a per-file one.
- `components/ui/**` is unlinted by choice, so a bad shadcn release ships
  unnoticed.
- Nothing measures banded output or colour accuracy. The pixel pass measures
  coverage, not how the printer reproduces it.
