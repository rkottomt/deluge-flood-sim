# Deluge HTTP API — design sketch

*Status: a design, not a service. What exists today is the `deluge` CLI ([README → Batch / API](../README.md#batch--api));
this is the shape of the HTTP wrapper around it, written down so a customer integration and the server can be built
against the same contract. October 2026.*

## Principles

* **The CLI is the engine.** Every endpoint is one CLI command with the same options and the same outputs
  ([`src/cli/commands.ts`](../src/cli/commands.ts)): `POST /v1/runs` is `deluge run`, `POST /v1/portfolio-assessments`
  is `deluge portfolio`, `POST /v1/site-checks` is `deluge site`. The server adds queueing, auth, storage and
  callbacks; it adds no physics and no loss arithmetic, so an API number equals a CLI number equals the browser's.
* **Jobs, not requests.** A run takes seconds to minutes of GPU time (a 12-member ensemble of a 30-minute Harvey hour
  is a few minutes on one consumer GPU), so every simulation endpoint answers `202 Accepted` with a job and the
  client polls or receives a webhook. Validation happens before queueing: a bad preset, level, stage, climate or CSV is
  a `400` at once (the CLI's exit code 2 cases), never a failed job an hour later.
* **Deterministic.** The same request on the same engine version gives the same numbers (the CLI's readbacks are on
  simulated time). Requests carry an `Idempotency-Key`; a repeated key returns the existing job. Every result records
  the engine version, the GPU and the scenario exactly as run.
* **Customer data stays put.** Portfolio CSVs are parsed by the same code as in the app (`parsePortfolio`, its limits:
  5,000 rows, 5 M characters) and kept only as long as the job's results (default 30 days, configurable, deletable).
  A private deployment runs the same container on the customer's own GPU host.

## Endpoints

| Method and path | CLI equivalent | Returns |
| --- | --- | --- |
| `GET /v1/presets` | `deluge presets --json --levels` | The scenarios, their forcing and Site check ladder levels |
| `POST /v1/runs` | `deluge run` | `202` + job; result: summary JSON + four GeoTIFFs |
| `POST /v1/portfolio-assessments` | `deluge portfolio` | `202` + job; result: results CSV (in-app export columns, optional `ens_*`) + summary JSON |
| `POST /v1/site-checks` | `deluge site` | `202` + job; result: the Site check report JSON |
| `GET /v1/jobs/{id}` | — | Status, progress (`fraction`, current case), timings, result links |
| `GET /v1/jobs/{id}/files/{name}` | the files the CLI writes | `summary.json`, `results.csv`, `max_depth_m.tif` … |
| `DELETE /v1/jobs/{id}` | — | Cancels a queued or running job (the worker stops it between frames); deletes stored results |

## OpenAPI (sketch)

```yaml
openapi: 3.1.0
info:
  title: Deluge flood simulation API
  version: 0.1.0
  description: >
    Headless runs of the Deluge GPU flood simulator. Each simulation endpoint queues a job that runs the `deluge` CLI
    command of the same name. Screening estimates, not engineering advice.
servers:
  - url: https://api.deluge.example/v1
security:
  - bearer: []
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
  parameters:
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: false
      schema: { type: string, maxLength: 128 }
  schemas:
    Scenario:
      type: object
      description: The CLI's shared scenario options. Unset fields keep the preset's own forcing.
      properties:
        minutes: { type: number, minimum: 2, maximum: 240, default: 30, description: Simulated minutes per run }
        level: { type: string, description: 'A Site check ladder level id (rp100, record1936, a14-100, x0.5 …) — CLI --scenario' }
        stageFt: { type: number, description: River or sea stage as a gauge reading in feet (presets with a stage) }
        rainMmHr: { type: number, minimum: 0, maximum: 1000 }
        scale: { type: number, minimum: 0, description: 'Rain, storm cells and inflows × scale' }
        manningN: { type: number, minimum: 0.005, maximum: 0.3 }
        climate:
          type: object
          properties:
            horizon: { enum: [today, '2050', '2080', '2100'], default: today }
            pathway: { enum: [ssp245, ssp585], default: ssp585 }
            scaling: { enum: [cc, super10, super14], default: cc }
    RunRequest:
      type: object
      required: [preset]
      properties:
        preset: { type: string, examples: [houston] }
        scenario: { $ref: '#/components/schemas/Scenario' }
        rasters: { type: boolean, default: true, description: false = summary only (CLI --no-rasters) }
        callbackUrl: { type: string, format: uri, description: POSTed the final Job when it ends }
    PortfolioRequest:
      type: object
      required: [preset, assetsCsv]
      properties:
        preset: { type: string }
        scenario: { $ref: '#/components/schemas/Scenario' }
        assetsCsv:
          type: string
          description: >
            The app's portfolio CSV (asset_id, lat/lon or wkt, occupancy, replacement_value, contents_value, currency,
            floors, gfa_m2, first_floor_height_m, critical_elev_m, basement, construction, daily_revenue, gross_margin,
            recapture, deductible, limit, tags). Also accepted as multipart/form-data part `assets`.
        ensemble:
          type: object
          properties:
            members: { type: integer, minimum: 3, maximum: 32 }
            seed: { type: integer, minimum: 1, maximum: 999999, default: 1 }
            demNoise: { type: boolean, default: true }
        callbackUrl: { type: string, format: uri }
    SiteRequest:
      type: object
      required: [preset, site]
      properties:
        preset: { type: string, examples: [pittsburgh] }
        scenario: { $ref: '#/components/schemas/Scenario' }
        site:
          type: object
          required: [lat, lon]
          properties:
            name: { type: string, maxLength: 40 }
            lat: { type: number }
            lon: { type: number }
            ring: { type: array, items: { type: array, items: { type: number }, minItems: 2, maxItems: 2 }, description: '[[lat, lon], …] parcel outline, 3–64 corners' }
            use: { enum: [res, apt, retail, office, warehouse, industrial, hospital, school, datacenter, civic, other], default: office }
            floors: { type: integer, minimum: 1, maximum: 100, default: 3 }
            valueUsd: { type: number }
            footprintM2: { type: number }
            firstFloorHeightM: { type: number }
            criticalElevM: { type: number }
        sweep:
          type: object
          description: Present = run the ladder (CLI --sweep); absent = one run of the scenario.
          properties:
            ladder: { type: string, enum: [stage, rain, scale], description: 'CLI --ladder; default the ladder the app picks' }
            levels: { type: array, items: { type: string }, description: Level ids; default the app's ticked levels }
            returnPeriods: { type: object, additionalProperties: { type: number }, description: '{ "x0.5": 10, "x1": 100 }' }
            design: { type: string }
            freeboardFt: { type: number }
        callbackUrl: { type: string, format: uri }
    Job:
      type: object
      properties:
        id: { type: string }
        kind: { enum: [run, portfolio, site] }
        status: { enum: [queued, running, succeeded, failed, cancelled] }
        progress: { type: object, properties: { fraction: { type: number }, case: { type: string } } }
        createdAt: { type: string, format: date-time }
        finishedAt: { type: string, format: date-time }
        engine: { type: object, properties: { version: { type: string }, gpu: { type: string } } }
        files:
          type: array
          items: { type: object, properties: { name: { type: string }, url: { type: string }, contentType: { type: string } } }
        error: { type: string, description: The CLI's stderr message when failed }
    Problem:
      type: object
      description: RFC 9457 problem details (invalid preset, level, stage, CSV …)
      properties: { type: { type: string }, title: { type: string }, detail: { type: string }, status: { type: integer } }
paths:
  /presets:
    get:
      summary: The scenarios and their Site check levels
      responses: { '200': { description: OK } }
  /runs:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/RunRequest' } } } }
      responses:
        '202': { description: Queued, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '400': { description: Invalid request, content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } } }
  /portfolio-assessments:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody:
        required: true
        content:
          application/json: { schema: { $ref: '#/components/schemas/PortfolioRequest' } }
          multipart/form-data: { schema: { type: object, properties: { request: { $ref: '#/components/schemas/PortfolioRequest' }, assets: { type: string, format: binary } } } }
      responses:
        '202': { description: Queued, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '400': { description: Invalid request or CSV, content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } } }
  /site-checks:
    post:
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }]
      requestBody: { required: true, content: { application/json: { schema: { $ref: '#/components/schemas/SiteRequest' } } } }
      responses:
        '202': { description: Queued, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }
        '400': { description: Invalid request, content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } } }
  /jobs/{id}:
    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
    get:
      responses: { '200': { description: The job, content: { application/json: { schema: { $ref: '#/components/schemas/Job' } } } }, '404': { description: Unknown job } }
    delete:
      responses: { '204': { description: Cancelled and deleted } }
  /jobs/{id}/files/{name}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: name, in: path, required: true, schema: { enum: [summary.json, results.csv, report.json, max_depth_m.tif, max_speed_ms.tif, arrival_min.tif, hazard_aidr.tif] } }
      responses: { '200': { description: The file }, '404': { description: Not produced by this job } }
```

## Example

```http
POST /v1/site-checks
Authorization: Bearer …
Idempotency-Key: 2f6c…

{ "preset": "pittsburgh",
  "site": { "name": "North Shore lot", "lat": 40.4425, "lon": -80.0085, "use": "office", "floors": 3 },
  "sweep": {} }
```

→ `202 { "id": "job_…", "status": "queued" }`; when it ends, `GET /v1/jobs/job_…/files/report.json` is exactly what
`deluge site --preset pittsburgh --at 40.4425,-80.0085 --use office --floors 3 --sweep` writes: per level the depth,
speed, AIDR class, arrival, egress, damage and loss; then `eal`, `exceedanceCurve`, `ffe`, `mitigation` and `verdict`.

## Building it (the next step)

1. **Worker.** A Node process per GPU that pulls jobs from a queue and calls the command handlers in-process with a
   `CliEnv` whose `write` goes to object storage and whose `log.progress` updates the job record — the commands are
   already written against that interface (`src/cli/commands.ts`), so no shelling out. Presets and the loaded terrain
   stay cached between jobs (loading is 2–6 s of a short run); one job at a time per GPU keeps runs deterministic.
2. **API process.** Validates with the same functions the CLI uses before the GPU starts (`resolveForcing`,
   `parsePortfolio`, `siteFromOptions`), writes the job, returns `202`. Auth, per-key quotas (asset × scenario-suite
   metering, BUSINESS.md §5), retention.
3. **Deployment.** One container image with Dawn and the presets; any Linux host with a Vulkan GPU (a cloud T4 / L4
   class card, or the customer's own box for a private deployment). Scale out by adding GPU workers.
4. **Later endpoints:** live areas (`?live=` areas by bounding box, which need the network for USGS / TIGER), a
   today-vs-future pair in one call (the Site check's *Today vs future*), and watch mode (re-run on a forecast,
   notify by webhook).
