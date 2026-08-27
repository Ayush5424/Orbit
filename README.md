# NEXUS

NEXUS is a local, single-machine task orchestration platform for the NEXUS Engineering Challenge. It accepts work through an HTTP API, persists accepted work before acknowledgement, dispatches it to logical workers, retries bounded failures with backoff, dead-letters exhausted work, records durable history, and exposes an operator console for diagnosis.

The system is intentionally small: Spring Boot + JPA + file-backed H2 for the backend, and React/Vite for the operator UI. It does not require cloud services, hosted queues, hosted databases, login, or internet access at runtime.

For Render deployment, the backend uses Neon Postgres through `DATABASE_URL`. The local H2 database is only the no-setup local fallback.

#Live Demo
- https://nexus-operator.onrender.com/

## Start On A Clean Machine

Prerequisites:

- Java 21
- Node.js and npm, only if running the frontend console

Backend, including local persisted storage:

```powershell
cd NEXUS
./mvnw spring-boot:run
```

Successful startup shows Spring Boot listening on port `8080`. The default database is `.\data\nexus.mv.db`; accepted work, events, workers, and releases survive backend restart.

Operator UI:

```powershell
cd NEXUS
npm run dev
```

Open the Vite URL, normally `http://localhost:5173`. The UI reads the backend at `http://localhost:8080`.

## Core API

Create work:

```powershell
Invoke-RestMethod -Method Post http://localhost:8080/tasks `
  -Headers @{"Idempotency-Key"="demo-1"} `
  -ContentType "application/json" `
  -Body '{"type":"EMAIL","payload":"hello"}'
```

Get operator diagnosis:

```powershell
Invoke-RestMethod http://localhost:8080/operator/diagnostics
```

See tasks, events, workers, and releases:

```powershell
Invoke-RestMethod http://localhost:8080/operator/tasks
Invoke-RestMethod http://localhost:8080/operator/events
Invoke-RestMethod http://localhost:8080/operator/workers
Invoke-RestMethod http://localhost:8080/operator/releases
```

## Failure Scenarios

Kill a logical worker:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/simulate/kill-worker?workerId=worker-1"
```

Stop/restart while accepted work exists:

1. Submit work.
2. Stop the Spring Boot process.
3. Restart with `.\mvnw.cmd spring-boot:run`.
4. Check `/operator/tasks` and `/operator/events`; stranded `PROCESSING` work is reset to `ACCEPTED` and records `TASK_RECOVERED`.

Make workers fail every task:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/failures/mode?mode=FAIL"
```

Make workers slow:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/failures/mode?mode=SLOW"
```

Deliver duplicate work:

```powershell
# Run this twice with the same Idempotency-Key.
Invoke-RestMethod -Method Post http://localhost:8080/tasks `
  -Headers @{"Idempotency-Key"="duplicate-demo"} `
  -ContentType "application/json" `
  -Body '{"type":"EMAIL","payload":"same work"}'
```

Push a bad release and roll it back:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/releases/deploy?version=v2.0.0-bad"
Invoke-RestMethod -Method Post "http://localhost:8080/operator/releases/undo"
```

Make cached value disagree with source:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/failures/mode?mode=CACHE_DISAGREE"
Invoke-RestMethod http://localhost:8080/operator/cache
```

Remove dependency:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/failures/mode?mode=DEPENDENCY_DOWN"
Invoke-RestMethod http://localhost:8080/operator/diagnostics
```

Return to normal:

```powershell
Invoke-RestMethod -Method Post "http://localhost:8080/operator/failures/mode?mode=NORMAL"
```

## Backlog

Submit many items by looping over unique idempotency keys. Dispatch is capped by `nexus.dispatch.batch-size` so recovery does not flood the worker executor.

```powershell
1..1000 | ForEach-Object {
  Invoke-RestMethod -Method Post http://localhost:8080/tasks `
    -Headers @{"Idempotency-Key"="bulk-$_"} `
    -ContentType "application/json" `
    -Body "{`"type`":`"EMAIL`",`"payload`":`"bulk-$_`"}" | Out-Null
}
```

Watch `/operator/diagnostics` for queued count and oldest queued age.

## Configuration

Defaults are local and offline:

- `PORT=8080`
- `DATABASE_URL=jdbc:h2:file:./data/nexus;AUTO_SERVER=FALSE;DB_CLOSE_DELAY=-1`
- `DB_USERNAME=sa`
- `DB_PASSWORD=`
- `DB_DRIVER=org.h2.Driver`
- `NEXUS_DISPATCH_BATCH_SIZE=25`
- `NEXUS_CACHE_MAX_AGE_SECONDS=60`

PostgreSQL remains available for local experiments through `DATABASE_URL` and `DB_DRIVER`, but it is not required for the challenge path.

## Deploy On Render

The repository includes `render.yaml` and `Dockerfile` for Render.

1. Push this repository to GitHub.
2. Create a Neon Postgres database and copy its connection string.
3. In Render, create a new Blueprint from the GitHub repo.
4. Render provisions:
   - `nexus-api` as a Docker web service.
   - `nexus-operator` as a static Vite site.
5. When Render prompts for `DATABASE_URL`, paste the Neon connection string.
6. The app converts Neon's `postgresql://...` URL to the JDBC URL Spring needs at startup.
7. The frontend receives `VITE_API_BASE_URL` from the API service's public `RENDER_EXTERNAL_URL`.

Do not set `DATABASE_URL` to the local H2 path on Render. Use Neon Postgres.

Important Render environment variables:

- `DATABASE_URL`: Neon Postgres connection string.
- `DB_DRIVER=org.postgresql.Driver`
- `CORS_ALLOWED_ORIGIN_PATTERNS=http://localhost:5173,https://*.onrender.com`
- `VITE_API_BASE_URL`: copied from `nexus-api` `RENDER_EXTERNAL_URL` at static-site build time.

## Tests

```powershell
cd C:\Users\dell\Downloads\NEXUS\NEXUS
.\mvnw.cmd test
```

The automated tests cover duplicate acceptance, retry/backoff/dead-letter behavior, startup recovery, release rollback, cache disagreement, dependency degradation, worker restart budget, and operator-visible incident state.
