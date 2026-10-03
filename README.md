# KantoPrint

Drop a PDF or image, get the paper stock, the ink load, and the flags that change
how the job runs — before a sheet moves.

Runs entirely on your machine. The only network call is to a local Ollama daemon.

```bash
pnpm install
ollama pull gemma4:e2b
pnpm fixtures
pnpm dev
```

## What it does

Per page: recommended tray stock, measured ink load, bleed status, rotation, and
one imperative line for whoever is holding the printer.

- Every page of a PDF is analysed. Results stream in page by page.
- Cards are collapsible when a file has more than one page.
- Filter a batch by tray, copy a load sheet, stop or retry any job.
- Done jobs survive a refresh.

## How it works

```
drop  ->  POST /api/analyze   (NDJSON, one line per page as it finishes)
          A  pdf-lib page boxes / sharp pixel dimensions, every page
          B  rasterise, then a raw-pixel pass: ink load, dark area,
             peak 64px tile, edge-band ink, saturation, alpha
          C  384px thumbnail -> Ollama gemma4:e2b, JSON-schema constrained
          D  measurements overrule the model; notes composed from the flags
```

`lib/prepress.ts` owns the contract. `verdictSchema` compiles to JSON Schema,
goes to Ollama as the `format` grammar, and the reply is parsed back through the
same schema. It is a `strictObject`: an undeclared field is an error, not
something to strip.

### Who decides what

A 2B model is good at judgement and bad at arithmetic about pixels. On the test
fixtures `gemma4:e2b` called a wide-margin contract _bleeding_ and a full-bleed
invitation _safe_, and rated a 0.9%-ink form "medium" beside a gauge reading 0.9%.

So measurement wins wherever measurement exists:

| Decision             | Owner                                       |
| -------------------- | ------------------------------------------- |
| Ink at the trim edge | pixels (≥5% bleeding, ≤0.5% provably clean) |
| Ink risk band        | pixels (10% / 22% thresholds)               |
| Turn the page 90°    | geometry                                    |
| What is this job?    | model                                       |
| Which paper?         | model                                       |

Three fields were deleted from the model contract after measuring them: they
disagreed with the numbers beside them and cost ~40 of the ~55 tokens generated
per page. The model returns three fields now.

`lib/flags.ts` is the one predicate list. The card renders chip labels, the notes
render instructions, and the batch sheet renders labels again — all from the same
array, so a flag cannot appear in one place and go missing from another.

## Performance

Core i5, 10 physical cores, no GPU.

|                               |             |
| ----------------------------- | ----------- |
| Raster + metadata, whole file | 0.1–0.3 s   |
| Pixel pass, per page          | 25–55 ms    |
| Vision, page never seen       | **11–17 s** |
| Vision, same page again       | 1.6–3.2 s   |
| Vision, cold model load       | 14–32 s     |

The gap between the last two rows is Ollama caching the vision encoding per
image. Re-running the same file is ~5× faster than seeing a new one, which is
why an early benchmark of this project was wrong.

A 20-page PDF is 4–6 minutes. Hence streaming, the page cap, and Stop.

Two levers: thumbnail size (the vision encoder runs at input resolution) and
output tokens. At 256px the model loses the artwork; 384px classifies correctly;
512px costs ~1.7× more and only helps for small type, so it is a switch.

At 384px an 11pt line on Letter is ~4.6px tall. The model cannot read body copy
and the card says so. Classification still works because the prompt carries the
measured ink profile.

## Layout

`lib/` is pure and framework-free, so the server and the browser make the same
decisions with one implementation.

| Module         | Role                                                  |
| -------------- | ----------------------------------------------------- |
| `prepress.ts`  | schemas, tray stock, ink thresholds                   |
| `raster.ts`    | page metadata, bounded raster, child-process timeouts |
| `pixels.ts`    | the raw-pixel measurement pass                        |
| `judge.ts`     | the Ollama call, reply validation, vision timeout     |
| `preflight.ts` | per-page orchestration and reconciliation             |
| `flags.ts`     | the one predicate list                                |
| `summary.ts`   | tray grouping and the batch sheet                     |

`hooks/use-job-queue.ts` owns intake, the serial drain, streaming, abort, retry
and persistence. `hooks/use-ollama-health.ts` owns polling. The console composes
`Header`, `Dropzone`, `TrayFilter`, `JobCard` and holds no logic.

A file is filed under one tray even when its pages disagree: majority wins, ties
go to page 1, and the card is badged `mixed`.

## Tests

```bash
pnpm test          # 60 unit tests, ~0.3s
pnpm test:model    # opt-in: drives the real daemon
```

Unit tests cover the schema contract, ink thresholds, the pixel pass against
synthetic images of known coverage, reconciliation, the flag list, tray grouping
and the batch sheet. No model, no daemon, no network.

`pnpm test:model` is the only place the acceptance criteria are asserted: every
reply parses, every page finishes inside a budget, every page of a PDF is
analysed, and aborting mid-document stops the work. Excluded from `pnpm test`
because CI has no Ollama.

CI runs lint, format, types, unit tests and build on every push.

## Tooling

```bash
pnpm lint          # oxlint + @shadcn/lint
pnpm lint:fix
pnpm format        # oxfmt
pnpm format:check
pnpm typecheck
```

Prettier and ESLint are gone. `.oxfmtrc.json` came from `oxfmt --migrate=prettier`
and keeps `semi: false`, `printWidth: 80` and tailwind class sorting.

`@shadcn/lint` runs all six recommended rules. Two rules shaped the code:

- `no-raw-colors` forced `--color-warning` and `--color-safe` into the theme. The
  ink gauge had been borrowing raw Tailwind amber and emerald; ink risk has three
  bands, so the theme now names all of them.
- `require-static-classes` forced the gauge colour to a conditional between
  complete class strings rather than a lookup the linter cannot follow.

Rules and options: <https://github.com/shadcn-ui/lint#rules>

`components/ui/**` and `app/globals.css` are excluded from lint and format. Both
are regenerated by `npx shadcn add`, so findings there are noise. Drop the
`ignorePatterns` entry to include them.

## Configuration

Every variable has a working default. See `.env.example`.

| Variable                    | Default                  |
| --------------------------- | ------------------------ |
| `OLLAMA_HOST`               | `http://127.0.0.1:11434` |
| `KANTOPRINT_MODEL`          | `gemma4:e2b`             |
| `KANTOPRINT_THREADS`        | physical core count      |
| `KANTOPRINT_CTX`            | `2048`                   |
| `KANTOPRINT_THUMB`          | `384`                    |
| `KANTOPRINT_THUMB_DETAIL`   | `512`                    |
| `KANTOPRINT_DPI`            | `150`                    |
| `KANTOPRINT_MAX_PAGES`      | `20`                     |
| `KANTOPRINT_RASTER_TIMEOUT` | `45000`                  |
| `KANTOPRINT_VISION_TIMEOUT` | `90000`                  |

## Fixtures

`pnpm fixtures` writes three deterministic files. No timestamps, no randomness,
so a verdict diff means a regression.

| File                              | Case                                         |
| --------------------------------- | -------------------------------------------- |
| `01-contract-low-ink.pdf`         | Letter, sparse monochrome text, wide margins |
| `02-invitation-heavy-ink.pdf`     | 5×7, full-bleed colour panels, 48% ink       |
| `03-badge-sticker-zero-bleed.png` | die-cut circle flush with the trim           |

## API

**`POST /api/analyze`** — one `file` per request, multipart. Optional
`detail=high`. Magic bytes decide the type; the browser's MIME is not trusted.
Responds `application/x-ndjson`: a `page` line per analysed page, then `done`, or
a single JSON error before streaming starts.

**`GET /api/health`** — reachability, whether the model is pulled, thread count.
503 when the daemon is down.

## Requirements

|                                    |                                        |
| ---------------------------------- | -------------------------------------- |
| Ollama + `gemma4:e2b`              | 4.6 GB download                        |
| `pdftoppm` (poppler-utils) or `gs` | sharp cannot decode PDF                |
| Node 20+                           | fixture script runs via type stripping |

## Known gaps

- A fresh page costs 11–17 s of CPU vision. That is the floor, not the app.
- Multi-page PDFs stop at `KANTOPRINT_MAX_PAGES`. There is no way to reach pages
  21–40 without splitting the file.
- Small print needs detail mode, and detail mode is global rather than per file.
- Coverage is measured; banded output and colour accuracy are not.
- `next/font/google` needs network at build time. Runtime is offline-safe.
