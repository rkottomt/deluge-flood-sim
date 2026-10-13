# Deluge HTTP API

*Status, October 2026: **built** — `deluge serve` ([`src/cli/server.ts`](../src/cli/server.ts),
[`src/cli/api.ts`](../src/cli/api.ts)) serves the `deluge` CLI ([README → Batch / API](../README.md#batch--api)) as an
HTTP job API on one machine's GPU. The sections marked **Not built yet** at the end are still a design.*

## Principles

* **The CLI is the engine.** Every simulation endpoint is one CLI command with the same options and the same outputs
  ([`src/cli/commands.ts`](../src/cli/commands.ts)): `POST /v1/runs` is `deluge run`, `POST /v1/portfolio-assessments`
  is `deluge portfolio`, `POST /v1/site-checks` is `deluge site`. A request is turned into exactly the options that
  command's parser would produce (each job records the equivalent command line, `command`), and the server runs the
  command handler in-process with an environment whose writes land in the job's directory. It adds queueing, auth,
  storage and retention; it adds no physics and no loss arithmetic, so an API number equals a CLI number equals the
  browser's. `tests/cli/server-gpu.test.ts` POSTs a run on the GPU and checks the four GeoTIFFs against the binary's,
  byte for byte, and the summary but for its timestamps and wall-clock timings.
* **Jobs, not requests.** A run takes seconds to minutes of GPU time, so every simulation endpoint answers
  `202 Accepted` with a job (and a `Location` header); the client polls `GET /v1/jobs/{id}` and downloads the files
  from it.
* **Fail fast.** Everything the CLI checks before its GPU starts is checked before the job is queued, by the same
  functions (`requirePreset`, `minutesOf`, `parseClimate`, `resolveForcing`, `siteFromOptions`, `planSite`,
  `parsePortfolio`): a bad preset, level, stage, climate, site, sweep or CSV is a `400` at once (the CLI's exit code 2
  cases), never a failed job later. The one check that needs the loaded grid — a site inside the map's bounds but
  outside its simulation grid — fails the job with a fixed sentence.
* **Deterministic.** The CLI's readbacks are on simulated time, so the same request on the same engine version gives
  the same numbers. An `Idempotency-Key` header makes a repeated request return the existing job. Every job records
  the engine version, the git commit, the GPU and the request as validated; every result file records the scenario as
  run (the summary's `scenario` and `run.gpu`, the report's `scenario` and `timing.gpu`).
* **One GPU queue.** Jobs run one at a time, first in, first out, on the process's one Dawn device — the deterministic
  path, and the GPU to itself.
* **Customer data stays put.** Portfolio CSVs are parsed by the app's `parsePortfolio` with its limits (5,000 rows,
  5 M characters). The CSV is written to the job's directory while the job waits and deleted when it ends; the job
  keeps only the counts and a SHA-256 of it. Results are kept for the retention period (default 30 days,
  `--retention-hours`) and deleted with `DELETE`.

## Running it

```bash
npx deluge serve                                   # http://127.0.0.1:8787, this machine only, no token
npx deluge serve --port 0 --data-dir /srv/deluge   # any free port (printed on start)
DELUGE_API_TOKEN=$(openssl rand -hex 24) npx deluge serve --host 0.0.0.0 --retention-hours 168
npx deluge serve --host 0.0.0.0 --token-file /etc/deluge/token
```

| Option | Default | |
| --- | --- | --- |
| `--host` | `127.0.0.1` | Any non-loopback address requires a token, or the server refuses to start (exit 2). |
| `--port` | `8787` | `0` = any free port. |
| `--token-file` / `DELUGE_API_TOKEN` | none | Bearer token, at least 16 printable characters. Kept off the command line so it does not show in a process list. |
| `--data-dir` | `results/api` | Job records and files: `<dir>/jobs/<id>/job.json` and the result files. Survives a restart. |
| `--retention-hours` | `720` | A finished job and its files are deleted this long after it ends (checked every few minutes). |
| `--max-queue` | `32` | Jobs waiting for the GPU at most; more are refused with `503`. |

Jobs held on disk survive a restart; a job that was queued or running when the server stopped is marked `failed`
("The server stopped before this job finished.") and its partial files deleted. Ctrl+C / SIGTERM cancels the running
job between frames and stops.

## Endpoints

| Method and path | CLI equivalent | Returns |
| --- | --- | --- |
| `GET /v1/health` | — | `{"status":"ok"}` — the only endpoint without auth |
| `GET /v1/presets` | `deluge presets --json --levels` | The scenarios, their forcing, bounds and Site check ladder levels |
| `POST /v1/runs` | `deluge run` | `202` + job; files: `summary.json` + four GeoTIFFs (`rasters: false` = summary only) |
| `POST /v1/portfolio-assessments` | `deluge portfolio` | `202` + job; files: `results.csv` (the in-app export's columns, `ens_*` with an ensemble) + `summary.json` |
| `POST /v1/site-checks` | `deluge site` | `202` + job; file: `report.json` (the Site check report) |
| `GET /v1/jobs` | — | The jobs held, newest first (id, kind, status, times) |
| `GET /v1/jobs/{id}` | — | The job: status, progress, engine, request, command, files, error |
| `GET /v1/jobs/{id}/results/{file}` | the files the CLI writes | The file, as an attachment (`…/files/{file}` is an alias) |
| `DELETE /v1/jobs/{id}` | — | Queued: cancelled, `204`. Running: `202`, the worker stops it between frames and deletes its files (status `cancelled`). Finished: the job and its files deleted, `204` |

The result names are fixed: `summary.json`, `results.csv`, `report.json`, `max_depth_m.tif`, `max_speed_ms.tif`,
`arrival_min.tif`, `hazard_aidr.tif`; a file is served only if it is one of those **and** the job wrote it **and**
the job succeeded.

### Requests

All `POST` bodies are `application/json`. Unknown fields are a `400` (a typo must not run the wrong scenario, as in
the CLI). The shared `scenario` object is the CLI's scenario options:

| Field | CLI | |
| --- | --- | --- |
| `scenario.minutes` | `--minutes` | 2–240; default 30 (120 for an Atlas 14 rain level; the sweep's own default on a rain or surge ladder) |
| `scenario.level` | `--scenario` | A ladder level id from `GET /v1/presets` (`rp100`, `record1936`, `a14-100`, `x0.5` …) |
| `scenario.stageFt` | `--stage-ft` | River / sea stage as a gauge reading, ft (presets with a stage) |
| `scenario.rainMmHr` | `--rain` | 0–1000 |
| `scenario.scale` | `--scale` | 0–100: rain, storm cells and inflows × scale |
| `scenario.manningN` | `--manning` | 0.005–0.3 |
| `scenario.climate` | `--climate` | `{ "horizon": "today"\|"2050"\|"2080"\|"2100", "pathway": "ssp245"\|"ssp585", "scaling": "cc"\|"super10"\|"super14" }` |

* **Run:** `{ "preset", "scenario"?, "rasters"?: true }`.
* **Portfolio:** `{ "preset", "scenario"?, "assetsCsv": "<the CSV as one string>", "ensemble"?: { "members": 3–32, "seed"?: 1–999999, "demNoise"?: true } }`.
  The CSV is the app's portfolio format (`asset_id`, `lat`/`lon` or `wkt`, values, floors, revenue, policy terms …).
  More than 5,000 rows, more than 5 M characters, no `asset_id` / location columns or no usable row is a `400`; rows
  the CLI would skip are skipped and counted (`request.assets.skippedRows`).
* **Site check:** `{ "preset", "scenario"?, "site": { "lat", "lon", "name"?, "ring"?: [[lat, lon], …] (3–64), "use"?, "floors"?, "valueUsd"?, "footprintM2"?, "firstFloorHeightM"?, "criticalElevM"? }, "sweep"?: { "ladder"?: "stage"|"rain"|"scale", "levels"?: [ids] | "all", "returnPeriods"?: { "x0.5": 10 }, "design"?, "freeboardFt"? }, "egress"?: { "occupants"?, "alertMin"?, "departure"?, "personsPerCar"?, "exitLanes"? } }`.
  `sweep` present (even `{}`) = `--sweep`; a sweep with `scenario.level` or `scenario.stageFt` is a `400`, as in the CLI.

### The job

```json
{
  "id": "job_849ae4d402ac878e51d53626",
  "kind": "run",
  "status": "succeeded",
  "progress": { "fraction": 1, "case": "done" },
  "createdAt": "2026-10-13T15:48:01.567Z", "startedAt": "2026-10-13T15:48:01.568Z", "finishedAt": "2026-10-13T15:48:07.166Z",
  "expiresAt": "2026-11-12T15:48:07.166Z",
  "engine": { "version": "0.1.0", "commit": "afb11f7deff1", "gpu": "nvidia turing nvidia-geforce-gtx-1660-ti D3D12 …" },
  "request": { "preset": "pittsburgh", "scenario": { "minutes": 10, "stageFt": 46 }, "rasters": true },
  "command": ["deluge", "run", "--preset", "pittsburgh", "--quiet", "--minutes", "10", "--stage-ft", "46", "--out", "."],
  "files": [
    { "name": "max_depth_m.tif", "url": "/v1/jobs/job_849ae4d402ac878e51d53626/results/max_depth_m.tif", "contentType": "image/tiff", "bytes": 4195304 },
    { "name": "summary.json", "url": "/v1/jobs/job_849ae4d402ac878e51d53626/results/summary.json", "contentType": "application/json", "bytes": 4299 }
  ],
  "error": null
}
```

`status` is `queued` (with `progress.position` in the queue), `running` (`progress.case` is the CLI's progress label:
`load`, `simulate`, `scenario`, `member 3/12`, `level 2/7 rp100`, and `fraction` that case's share done),
`succeeded`, `failed` or `cancelled`. `error` is a fixed sentence when the job failed; the cause goes to the server's
log, not the response.

### Idempotency

`Idempotency-Key: <1–128 printable ASCII characters>` on a `POST`: a repeat with the same key and the same body returns
the existing job with `200` and `Idempotent-Replayed: true` (whatever its status); the same key with a different body
is a `409`. Keys live as long as their job.

### Errors

RFC 9457 `application/problem+json`: `{ "type": "about:blank", "title", "status", "detail" }`. The `detail` is always
a fixed sentence chosen by the check that failed — it may name a schema field (`scenario.stageFt is outside this
preset's gauge range …`) and the schema's own limits, but **never contains anything from the request**: not a preset
name, a level id, a CSV cell or a header. (The CLI's messages quote their input, which is right on a terminal; they are
never passed through.)

| Status | When |
| --- | --- |
| `400` | Invalid JSON, UTF-8, field, value, preset, level, stage, climate, site, sweep, CSV; bad `Idempotency-Key` |
| `401` | Missing or wrong bearer token (with `WWW-Authenticate: Bearer`) |
| `403` | A `Host` header that is not a loopback name, on a loopback bind |
| `404` | Unknown endpoint, job or file |
| `405` | Wrong method (with `Allow`) |
| `409` | `Idempotency-Key` reused for a different request |
| `413` | Body over the cap (the connection is then closed) |
| `415` | A `POST` that is not `application/json` |
| `503` | The queue is full, or the server is stopping |

## Security

* **Bind.** `127.0.0.1` by default. Any other address needs a token; without one `deluge serve` exits with code 2.
* **Auth.** With a token, every endpoint but `/v1/health` needs `Authorization: Bearer <token>`, compared in constant
  time (SHA-256 of both sides, `timingSafeEqual`). One token, one tenant: there are no per-key quotas yet.
* **Browsers.** On a loopback bind the `Host` header must be `localhost`, `127.x.x.x` or `[::1]`, so a web page that
  rebinds its own name to 127.0.0.1 is refused (`403`). `POST`s must be `application/json`, which a page cannot send
  cross-site without a CORS preflight — and the server sends no CORS headers at all. Every response carries
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'` and
  `Referrer-Policy: no-referrer`; downloads are `Content-Disposition: attachment`.
* **Sizes and time.** Bodies: 64 KiB, 12 MiB for a portfolio (its CSV JSON-escaped), checked on `Content-Length` and
  again while streaming; then the CSV is held to 5 M characters and 5,000 rows. Headers 16 KiB and 15 s, a request
  120 s, at most `--max-queue` jobs waiting.
* **Paths.** Job ids match `job_` + 24 hex digits, file names one of the seven result names, before any path is built
  — a download cannot leave the job's directory (`..`, `%2f`, `%2e%2e`, backslashes, NUL all end in `404`). Requests
  are never decoded into paths, and the server reads nothing outside `<data-dir>/jobs/`.
* **Echo.** Error messages are fixed sentences (above). The server's own log has job ids, kinds and preset ids
  (already validated) and error causes with non-printable characters replaced — never request bodies.
* **No outbound requests.** The server makes none: no webhooks (see below), no fetches of client-given URLs, so there
  is no SSRF surface. A `callbackUrl` field is a `400` like any other unknown field.
* **Retention.** Finished jobs and their files are deleted after `--retention-hours`; a portfolio's CSV as soon as its
  job ends; a cancelled or failed job's partial files at once.

`npm run test:security` runs these as its `API-*` cases against a real `deluge serve` process (bind, auth, Host / CORS
/ content type, 16 traversal paths, declared and chunked body caps and the row cap, hostile requests that must not be
echoed); `tests/cli/server.test.ts` covers the same rules, the job lifecycle, retention and restart without a GPU.

## Example

```bash
$ curl -s -X POST localhost:8787/v1/runs -H 'content-type: application/json' -H 'idempotency-key: demo-1' \
    -d '{"preset":"pittsburgh","scenario":{"stageFt":46,"minutes":10}}'
{ "id": "job_849ae4d402ac878e51d53626", "kind": "run", "status": "running", "progress": { "fraction": 0, "case": "load" }, … }

$ curl -s localhost:8787/v1/jobs/job_849ae4d402ac878e51d53626        # until "status": "succeeded"
$ curl -s -O localhost:8787/v1/jobs/job_849ae4d402ac878e51d53626/results/max_depth_m.tif
$ curl -s -X DELETE localhost:8787/v1/jobs/job_849ae4d402ac878e51d53626   # 204: job and files gone
```

The `max_depth_m.tif` downloaded here has the same SHA-256 as the one `deluge run --preset pittsburgh --stage-ft 46
--minutes 10` writes. A site check:

```http
POST /v1/site-checks
Authorization: Bearer …
Content-Type: application/json
Idempotency-Key: 2f6c…

{ "preset": "pittsburgh",
  "site": { "name": "North Shore lot", "lat": 40.4425, "lon": -80.0085, "use": "office", "floors": 3 },
  "sweep": {} }
```

→ `202`, and when it ends `GET /v1/jobs/job_…/results/report.json` is what `deluge site --preset pittsburgh --at
40.4425,-80.0085 --name "North Shore lot" --use office --floors 3 --sweep` writes: per level the depth, speed, AIDR
class, arrival, egress, damage and loss; then `eal`, `exceedanceCurve`, `ffe`, `mitigation` and `verdict`.

## OpenAPI

```yaml
openapi: 3.1.0
info:
  title: Deluge flood simulation API
  version: 0.1.0
  description: >
    Headless runs of the Deluge GPU flood simulator (`deluge serve`). Each simulation endpoint queues a job that runs
    the `deluge` CLI command of the same name. Screening estimates, not engineering advice.
servers:
  - url: http://127.0.0.1:8787/v1
security:
  - bearer: []
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer, description: Required when the server has a token (always off loopback) }
  parameters:
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: false
      schema: { type: string, pattern: '^[\x21-\x7e]{1,128}$' }
  schemas:
    Scenario:
      type: object
      additionalProperties: false
      description: The CLI's shared scenario options. Unset fields keep the preset's own forcing.
      properties:
        minutes: { type: number, minimum: 2, maximum: 240, description: Simulated minutes per run (default 30) }
        level: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$', description: 'A Site check ladder level id (rp100, record1936, a14-100, x0.5 …) — CLI --scenario' }
        stageFt: { type: number, description: River or sea stage as a gauge reading in feet (presets with a stage) }
        rainMmHr: { type: number, minimum: 0, maximum: 1000 }
        scale: { type: number, minimum: 0, maximum: 100, description: 'Rain, storm cells and inflows × scale' }
        manningN: { type: number, minimum: 0.005, maximum: 0.3 }
        climate:
          type: object
          additionalProperties: false
          properties:
            horizon: { enum: [today, '2050', '2080', '2100'], default: today }
            pathway: { enum: [ssp245, ssp585], default: ssp585 }
            scaling: { enum: [cc, super10, super14], default: cc }
    RunRequest:
      type: object
      additionalProperties: false
      required: [preset]
      properties:
        preset: { type: string, examples: [houston] }
        scenario: { $ref: '#/components/schemas/Scenario' }
        rasters: { type: boolean, default: true, description: false = summary only (CLI --no-rasters) }
    PortfolioRequest:
      type: object
      additionalProperties: false
      required: [preset, assetsCsv]
      properties:
        preset: { type: string }
        scenario: { $ref: '#/components/schemas/Scenario' }
        assetsCsv: { type: string, maxLength: 5000000, description: 'The app''s portfolio CSV, at most 5,000 rows' }
        ensemble:
          type: object
          additionalProperties: false
          required: [members]
          properties:
            members: { type: integer, minimum: 3, maximum: 32 }
            seed: { type: integer, minimum: 1, maximum: 999999, default: 1 }
            demNoise: { type: boolean, default: true }
    SiteRequest:
      type: object
      additionalProperties: false
      required: [preset, site]
      properties:
        preset: { type: string, examples: [pittsburgh] }
        scenario: { $ref: '#/components/schemas/Scenario' }
        site:
          type: object
          additionalProperties: false
          required: [lat, lon]
          properties:
            name: { type: string, maxLength: 40 }
            lat: { type: number, minimum: -90, maximum: 90 }
            lon: { type: number, minimum: -180, maximum: 180 }
            ring: { type: array, minItems: 3, maxItems: 64, items: { type: array, items: { type: number }, minItems: 2, maxItems: 2 }, description: '[[lat, lon], …] parcel outline' }
            use: { enum: [res, apt, retail, office, warehouse, industrial, hospital, school, datacenter, civic, other], default: office }
            floors: { type: integer, minimum: 1, maximum: 100, default: 3 }
            valueUsd: { type: number, minimum: 0, maximum: 1.0e11 }
            footprintM2: { type: number, minimum: 1, maximum: 1.0e6 }
            firstFloorHeightM: { type: number, minimum: 0, maximum: 10 }
            criticalElevM: { type: number, minimum: 0, maximum: 30 }
        sweep:
          type: object
          additionalProperties: false
          description: Present = run the ladder (CLI --sweep); absent = one run of the scenario.
          properties:
            ladder: { enum: [stage, rain, scale], description: 'CLI --ladder; default the ladder the app picks' }
            levels: { oneOf: [{ const: all }, { type: array, minItems: 1, maxItems: 32, items: { type: string } }], description: Level ids; default the app's ticked levels }
            returnPeriods: { type: object, additionalProperties: { type: number, minimum: 1, maximum: 100000 }, description: '{ "x0.5": 10, "x1": 100 }' }
            design: { type: string }
            freeboardFt: { type: number, minimum: 0, maximum: 10 }
        egress:
          type: object
          additionalProperties: false
          description: Leaving by road (CLI --occupants, --alert-min, --departure, --persons-per-car, --exit-lanes); absent = the defaults.
          properties:
            occupants: { type: integer, minimum: 1, maximum: 100000 }
            alertMin: { type: number, minimum: -1440, maximum: 1440, description: Minutes after the run starts; negative = warned before it }
            departure: { enum: [good-likely, poor-likely, poor-unlikely, fast] }
            personsPerCar: { type: number, minimum: 1, maximum: 10 }
            exitLanes: { type: integer, minimum: 1, maximum: 12 }
    Job:
      type: object
      properties:
        id: { type: string, pattern: '^job_[0-9a-f]{24}$' }
        kind: { enum: [run, portfolio, site] }
        status: { enum: [queued, running, succeeded, failed, cancelled] }
        progress: { type: [object, 'null'], properties: { fraction: { type: number }, case: { type: string }, position: { type: integer } } }
        createdAt: { type: string, format: date-time }
        startedAt: { type: [string, 'null'], format: date-time }
        finishedAt: { type: [string, 'null'], format: date-time }
        expiresAt: { type: [string, 'null'], format: date-time }
        cancelRequested: { type: boolean }
        engine: { type: object, properties: { version: { type: string }, commit: { type: [string, 'null'] }, gpu: { type: [string, 'null'] } } }
        request: { type: object, description: The request as validated (a portfolio's CSV replaced by rows / usable / skippedRows / sha256) }
        command: { type: array, items: { type: string }, description: The equivalent deluge command line }
        files:
          type: array
          items: { type: object, properties: { name: { type: string }, url: { type: string }, contentType: { type: string }, bytes: { type: integer } } }
        error: { type: [string, 'null'], description: A fixed sentence when the job failed }
    Problem:
      type: object
      description: RFC 9457 problem details; detail is a fixed sentence that never contains request input
      properties: { type: { type: string }, title: { type: string }, detail: { type: string }, status: { type: integer } }
  responses:
    Problem: { description: Error, content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } } }
    Queued:
      description: Queued
      headers: { Location: { schema: { type: string } } }
      content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } }
    Replayed:
      description: The existing job for this Idempotency-Key
      headers: { Idempotent-Replayed: { schema: { const: 'true' } } }
      content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } }
paths:
  /health:
    get: { security: [], responses: { '200': { description: OK } } }
  /presets:
    get: { summary: The scenarios and their Site check levels, responses: { '200': { description: OK } } }
  /runs:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/RunRequest' } } } }
      responses: { '202': { $ref: '#/components/responses/Queued' }, '200': { $ref: '#/components/responses/Replayed' }, '400': { $ref: '#/components/responses/Problem' }, '409': { $ref: '#/components/responses/Problem' }, '413': { $ref: '#/components/responses/Problem' }, '503': { $ref: '#/components/responses/Problem' } }
  /portfolio-assessments:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/PortfolioRequest' } } } }
      responses: { '202': { $ref: '#/components/responses/Queued' }, '200': { $ref: '#/components/responses/Replayed' }, '400': { $ref: '#/components/responses/Problem' }, '409': { $ref: '#/components/responses/Problem' }, '413': { $ref: '#/components/responses/Problem' }, '503': { $ref: '#/components/responses/Problem' } }
  /site-checks:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/SiteRequest' } } } }
      responses: { '202': { $ref: '#/components/responses/Queued' }, '200': { $ref: '#/components/responses/Replayed' }, '400': { $ref: '#/components/responses/Problem' }, '409': { $ref: '#/components/responses/Problem' }, '413': { $ref: '#/components/responses/Problem' }, '503': { $ref: '#/components/responses/Problem' } }
  /jobs:
    get: { responses: { '200': { description: The jobs held, newest first } } }
  /jobs/{id}:
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    get:
      responses: { '200': { description: The job, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }, '404': { $ref: '#/components/responses/Problem' } }
    delete:
      responses: { '204': { description: Cancelled (queued) or deleted (finished) }, '202': { description: Running — cancel requested; the job ends as cancelled with its files deleted }, '404': { $ref: '#/components/responses/Problem' } }
  /jobs/{id}/results/{name}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: name, in: path, required: true, schema: { enum: [summary.json, results.csv, report.json, max_depth_m.tif, max_speed_ms.tif, arrival_min.tif, hazard_aidr.tif] } }
      responses: { '200': { description: The file (attachment) }, '404': { $ref: '#/components/responses/Problem' } }
```

## Not built yet (still a sketch)

* **Webhooks.** `callbackUrl` (POST the final job when it ends) is not implemented, on purpose: a server that fetches
  client-given URLs is an SSRF hazard, and refusing private and loopback addresses correctly means resolving the name,
  pinning the address for the connection (DNS rebinding), refusing redirects and checking every IPv4/IPv6 private,
  link-local and metadata range. Until that is built and tested, clients poll.
* **Multipart upload** of the portfolio CSV (`multipart/form-data`, part `assets`); today it is a JSON string.
* **Per-key tokens, quotas and metering** (asset × scenario-suite metering, BUSINESS.md §5): today one token, one
  tenant.
* **Scale-out.** A worker per GPU pulling from a shared queue, with object storage for results (the commands are
  already written against `CliEnv`, so a worker only swaps `write`), and presets / loaded terrain cached between jobs
  (loading is 2–6 s of a short run; today each job loads its preset).
* **Deployment.** One container image with Dawn and the presets; any Linux host with a Vulkan GPU (a cloud T4 / L4
  class card, or the customer's own box for a private deployment), TLS terminated in front of it.
* **Later endpoints:** live areas (`?live=` areas by bounding box, which need the network for USGS / TIGER), a
  today-vs-future pair in one call (the Site check's *Today vs future*), and watch mode (re-run on a forecast,
  notify by webhook).
