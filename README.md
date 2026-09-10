# ORBIT

ORBIT is a fault-tolerant task orchestration platform. It accepts work through an HTTP API, persists accepted work before acknowledgement, dispatches it to logical workers, retries bounded failures with backoff, dead-letters exhausted work, records durable history, and exposes an operator console for diagnosis.

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
cd C:\Users\dell\Downloads\NEXUS\NEXUS
.\mvnw.cmd spring-boot:run
```

Successful startup shows Spring Boot listening on port `8080`. The default database is `.\data\nexus.mv.db`; accepted work, events, workers, and releases survive backend restart.

Operator UI:

```powershell
cd C:\Users\dell\Downloads\NEXUS\NEXUS\frontend
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

## Deploy On Render & 15-Minute Inactivity Fix

Render free-tier web services spin down after 15 minutes of inactivity. Orbit handles this automatically with multi-layer resilience:

1. **Automatic Frontend Wake-Up & Cold Start UX**:
   - When you visit `https://nexus-operator.onrender.com` (or `https://orbit-operator.onrender.com`), the frontend immediately sends a wake-up ping to the backend API (`https://nexus-api-cbql.onrender.com`).
   - While Render boots the Docker container (~30–50s), the UI displays an animated Orbit radar with live elapsed countdown, progress indicator, and automatic polling until the backend is fully awake.
   - You never see confusing "unable to connect" crashes during cold start.

2. **Active Browser Tab Keep-Alive**:
   - While the operator console is open in your browser, it automatically transmits background heartbeat pings to `/actuator/health` every 4 minutes.
   - This ensures Render will **never** spin down while someone is viewing or using the platform.

3. **Backend Self-Ping (`KeepAliveService`)**:
   - The Spring Boot backend includes `KeepAliveService`, which pings its own public URL every 10 minutes while active, keeping Render's 15-minute inactivity timer reset.

4. **24/7 Zero-Downtime Free Keep-Alive (Optional)**:
   - If you want the backend to stay awake 24/7 even when no browser tabs are open:
     1. Go to [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) (free).
     2. Add a monitor for: `https://nexus-api-cbql.onrender.com/actuator/health`
     3. Set the interval to every **10 minutes**.
     4. Render will register regular HTTP traffic and never shut the service down.

### Renaming Deployed Services in Render

To rename your deployed services on Render:
1. Open your **Render Dashboard**.
2. For the frontend static site:
   - Go to **Settings** > change **Name** to `orbit-operator`.
   - Your URL becomes `https://orbit-operator.onrender.com`.
3. For the backend web service:
   - Go to **Settings** > change **Name** to `orbit-api`.
   - Your URL becomes `https://orbit-api.onrender.com`.
4. The frontend code is pre-configured to automatically recognize both `orbit-operator` and `nexus-operator` domains and connect to the right backend.

---

## Tests

```powershell
cd C:\Users\dell\Downloads\NEXUS\NEXUS
.\mvnw.cmd test
```

The automated tests cover duplicate acceptance, retry/backoff/dead-letter behavior, startup recovery, release rollback, cache disagreement, dependency degradation, worker restart budget, and operator-visible incident state.

