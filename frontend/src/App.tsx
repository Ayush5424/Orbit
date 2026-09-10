import { useEffect, useState } from "react";
import "./App.css";

// Resolve backend API URL with automatic fallback to deployed Render backend
const resolveApiUrl = (): string => {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL.replace(/\/+$/, "");
  }
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host.includes("orbit-operator.onrender.com")) {
      return "https://orbit-api.onrender.com";
    }
    if (host.includes("onrender.com")) {
      return "https://nexus-api-cbql.onrender.com";
    }
  }
  return "http://localhost:8080";
};

const API = resolveApiUrl();

type Worker = {
  workerId: string;
  maxRestarts: number;
  failureCount: number;
  lastHeartbeat: string;
  restartCount: number;
  status: string;
};

type Task = {
  id: string;
  type: string;
  payload: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
};

type Event = {
  id: string;
  type: string;
  details: string;
  createdAt: string;
};

type Diagnostics = {
  status: "HEALTHY" | "WARNING" | "DEGRADED" | "CRITICAL";
  humanReadableSummary: string;
  abnormalBelief: string;
  oldestQueuedAgeSeconds: number | "NONE";
  activeRelease: string;
  cache: {
    ageSeconds: number;
    maxAgeSeconds: number;
    sourceAvailable: boolean;
    disagreement: boolean;
    servedMode: string;
  };
  timestamp: string;
};

type Release = {
  id: number;
  version: string;
  status: string;
  deployedAt: string;
};

type Status = {
  totalTasks: number;
  acceptedTasks: number;
  processingTasks: number;
  completedTasks: number;
  retryingTasks: number;
  deadLetterTasks: number;
  failureMode: string;
  workers: Worker[];
};

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);

  const [payload, setPayload] = useState("");
  const [newVersion, setNewVersion] = useState("");
  const [failureMode, setFailureMode] = useState("NORMAL");
  const [loading, setLoading] = useState(false);
  const [workerLoading, setWorkerLoading] = useState(false);

  // Cold-start wake-up tracking
  const [wakeUpSeconds, setWakeUpSeconds] = useState(0);
  const [isAttemptingWake, setIsAttemptingWake] = useState(false);

  // Timer for tracking wake-up duration when backend is waking up
  useEffect(() => {
    let interval: number | undefined;
    if (!status) {
      interval = window.setInterval(() => {
        setWakeUpSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setWakeUpSeconds(0);
    }
    return () => clearInterval(interval);
  }, [status]);

  // Active Tab Keep-Alive: Ping backend health every 4 mins to prevent 15-min Render spin-down
  useEffect(() => {
    const keepAliveInterval = setInterval(() => {
      fetch(`${API}/actuator/health`).catch(() => {});
    }, 4 * 60 * 1000);
    return () => clearInterval(keepAliveInterval);
  }, []);

  const loadData = async () => {
    setIsAttemptingWake(true);
    try {
      const [statusRes, tasksRes, eventsRes, diagRes, releasesRes] = await Promise.all([
        fetch(`${API}/operator/status`),
        fetch(`${API}/operator/tasks`),
        fetch(`${API}/operator/events`),
        fetch(`${API}/operator/diagnostics`),
        fetch(`${API}/operator/releases`),
      ]);

      if (!statusRes.ok || !tasksRes.ok || !eventsRes.ok) {
        throw new Error(`Backend unavailable (HTTP ${statusRes.status})`);
      }

      setStatus(await statusRes.json());
      setTasks(await tasksRes.json());
      setEvents(await eventsRes.json());

      if (diagRes.ok) setDiagnostics(await diagRes.json());
      if (releasesRes.ok) setReleases(await releasesRes.json());
    } catch (error) {
      console.warn("Backend connection poll (waking up or offline):", error);
    } finally {
      setIsAttemptingWake(false);
    }
  };

  useEffect(() => {
    // Immediate wake-up call upon page load
    loadData();
    // Fast polling (2.5s) to reconnect quickly during cold start and update live data
    const interval = setInterval(loadData, 2500);
    return () => clearInterval(interval);
  }, []);

  const createTask = async () => {
    if (!payload.trim()) return;
    setLoading(true);

    try {
      await fetch(`${API}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          type: "EMAIL",
          payload,
        }),
      });

      setPayload("");
      await loadData();
    } catch (error) {
      console.error("Failed to create task:", error);
    } finally {
      setLoading(false);
    }
  };

  const createWorker = async () => {
    setWorkerLoading(true);
    try {
      const generatedId = `worker-${Math.random().toString(36).substring(2, 7)}`;
      const res = await fetch(`${API}/operator/workers?workerId=${generatedId}`, {
        method: "POST",
      });

      if (!res.ok) throw new Error(`Failed to create worker: ${res.status}`);
      await loadData();
    } catch (error) {
      console.error("Failed to add worker:", error);
    } finally {
      setWorkerLoading(false);
    }
  };

  const deleteWorker = async (workerId: string) => {
    try {
      const res = await fetch(`${API}/operator/workers/${workerId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Failed to delete worker`);
      await loadData();
    } catch (error) {
      console.error("Failed to delete worker:", error);
    }
  };

  const changeFailureMode = async (mode: string) => {
    try {
      await fetch(`${API}/operator/failures/mode?mode=${mode}`, {
        method: "POST",
      });
      setFailureMode(mode);
      await loadData();
    } catch (error) {
      console.error("Failed to change failure mode:", error);
    }
  };

  // --- R-06 CORE: Release Deploy & One-Click Undo ---
  const deployRelease = async () => {
    if (!newVersion.trim()) return;
    try {
      await fetch(`${API}/operator/releases/deploy?version=${encodeURIComponent(newVersion)}`, {
        method: "POST",
      });
      setNewVersion("");
      await loadData();
    } catch (error) {
      console.error("Failed to deploy release:", error);
    }
  };

  const rollbackRelease = async () => {
    try {
      await fetch(`${API}/operator/releases/undo`, {
        method: "POST",
      });
      await loadData();
    } catch (error) {
      console.error("Failed to rollback release:", error);
    }
  };

  // --- R-15 / Thing 04: Simulation Triggers ---
  const killWorkerMidTask = async (workerId: string) => {
    try {
      await fetch(`${API}/operator/simulate/kill-worker?workerId=${workerId}`, {
        method: "POST",
      });
      await loadData();
    } catch (error) {
      console.error("Failed to kill worker:", error);
    }
  };

  const activeRelease = releases.find((r) => r.status === "ACTIVE");

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>ORBIT</h1>
          <p>Fault-Tolerant Task Orchestration Platform</p>
        </div>

        <div className="connection">
          <span className="pulse"></span>
          ORBIT ONLINE {activeRelease && `(${activeRelease.version})`}
        </div>
      </header>

      {!status ? (
        <div className="wake-up-container">
          <div className="orbit-radar">
            <div className="orbit-ring ring-1"></div>
            <div className="orbit-ring ring-2"></div>
            <div className="orbit-pulse-core">🪐</div>
          </div>

          <h2>Waking Up Orbit Backend</h2>
          <p className="wake-up-target">
            Target Service: <code>{API}</code>
          </p>

          <div className="wake-up-status-card">
            <div className="wake-up-timer-bar">
              <span className="live-badge">
                <span className="live-dot"></span>
                {isAttemptingWake ? "Pinging Service..." : "Awaiting Wake-up"}
              </span>
              <strong>Elapsed: {wakeUpSeconds}s</strong>
            </div>

            <p className="wake-up-explanation">
              {wakeUpSeconds < 4 ? (
                "Triggering immediate wake-up call to backend on Render..."
              ) : wakeUpSeconds < 35 ? (
                "Render free web services spin down after 15 min of inactivity. The Docker container is currently spinning up (~30–50s)..."
              ) : wakeUpSeconds < 70 ? (
                "Container started! Initializing Spring Boot application context & database connection..."
              ) : (
                "Still awaiting backend response. Free tier cold boots can take up to 90 seconds depending on Render platform load."
              )}
            </p>

            <div className="wake-up-progress-bar">
              <div
                className="wake-up-progress-fill"
                style={{
                  width: `${Math.min(100, Math.max(8, (wakeUpSeconds / 55) * 100))}%`,
                }}
              ></div>
            </div>

            <div className="wake-up-actions">
              <button
                className="retry-wake-btn"
                onClick={() => {
                  loadData();
                }}
                disabled={isAttemptingWake}
              >
                {isAttemptingWake ? "🔄 Sending Ping..." : "🔄 Ping Backend Now"}
              </button>
            </div>
          </div>

          <div className="keep-alive-note">
            💡 <strong>Render Inactivity Solution:</strong> Once connected, this console automatically sends keep-alive heartbeats every 4 minutes so Render never sleeps while you have this tab open.
          </div>
        </div>
      ) : (
        <>
          {diagnostics && (
            <div
              className={`diagnostic-banner status-${diagnostics.status.toLowerCase()}`}
            >
              <div className="diagnostic-topline">
                <span>ORBIT DIAGNOSTIC ASSESSMENT (90-Sec Rule)</span>
                <small>{new Date(diagnostics.timestamp).toLocaleTimeString()}</small>
              </div>
              <p>{diagnostics.humanReadableSummary}</p>
              <div className="diagnostic-details">
                <span>Belief: {diagnostics.abnormalBelief}</span>
                <span>Oldest queued: {diagnostics.oldestQueuedAgeSeconds}s</span>
                <span>Release: {diagnostics.activeRelease}</span>
                <span>Cache: {diagnostics.cache.servedMode}</span>
              </div>
            </div>
          )}

          <section className="metrics">
            <Metric title="Total Tasks" value={status.totalTasks} />
            <Metric title="Completed" value={status.completedTasks} />
            <Metric title="Processing" value={status.processingTasks} />
            <Metric title="Retrying" value={status.retryingTasks} />
            <Metric title="Dead Letter" value={status.deadLetterTasks} danger />
            <Metric title="Workers" value={status.workers.length} />
          </section>

          {/* R-06 & R-15: Controls Panel */}
          <div className="grid">
            <section className="control-panel">
              <div>
                <h2>Failure Simulation (Thing 04)</h2>
                <p>
                  Current failure mode: <b>{status.failureMode}</b>
                </p>
              </div>

              <div className="controls">
                <button
                  className={failureMode === "NORMAL" ? "active" : ""}
                  onClick={() => changeFailureMode("NORMAL")}
                >
                  NORMAL
                </button>

                <button
                  className={failureMode === "FAIL" ? "danger active" : "danger"}
                  onClick={() => changeFailureMode("FAIL")}
                >
                  FAIL MODE
                </button>
                <button
                  className={failureMode === "SLOW" ? "active" : ""}
                  onClick={() => changeFailureMode("SLOW")}
                >
                  SLOW
                </button>
                <button
                  className={failureMode === "DEPENDENCY_DOWN" ? "danger active" : "danger"}
                  onClick={() => changeFailureMode("DEPENDENCY_DOWN")}
                >
                  DEP DOWN
                </button>
                <button
                  className={failureMode === "CACHE_DISAGREE" ? "active" : ""}
                  onClick={() => changeFailureMode("CACHE_DISAGREE")}
                >
                  CACHE DIFF
                </button>
              </div>
            </section>

            {/* R-06 CORE: Release & One-Click Rollback Controls */}
            <section className="control-panel">
              <div>
                <h2>Release Controls (R-06)</h2>
                <p>Active Version: <b>{activeRelease ? activeRelease.version : "v1.0.0"}</b></p>
              </div>

              <div className="controls" style={{ gap: "8px" }}>
                <input
                  type="text"
                  placeholder="v1.1.0"
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                  style={{ padding: "6px", width: "80px" }}
                />
                <button onClick={deployRelease}>Deploy</button>
                <button className="danger" onClick={rollbackRelease} title="Undo last release in one click">
                  ↺ Undo Release
                </button>
              </div>
            </section>
          </div>

          <section className="create-task">
            <h2>Create Task</h2>

            <div className="task-form">
              <input
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                placeholder="Enter task payload..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") createTask();
                }}
              />

              <button onClick={createTask} disabled={loading}>
                {loading ? "Creating..." : "Create Task"}
              </button>
            </div>
          </section>

          <div className="grid">
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2>Worker Health</h2>
                  <span>{status.workers.length} workers</span>
                </div>
                <button
                  className="add-worker-btn"
                  onClick={createWorker}
                  disabled={workerLoading}
                >
                  {workerLoading ? "+ Adding..." : "+ Add Worker"}
                </button>
              </div>

              <div className="workers">
                {status.workers.map((worker) => (
                  <div className="worker" key={worker.workerId}>
                    <div className="worker-top">
                      <div className="worker-name">
                        <span
                          className={
                            worker.status === "RUNNING"
                              ? "status-dot"
                              : "status-dot offline-dot"
                          }
                        ></span>
                        {worker.workerId}
                      </div>

                      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                        <span className={worker.status === "RUNNING" ? "badge success" : "badge danger"}>
                          {worker.status}
                        </span>

                        {/* Trigger worker crash mid-task (Thing 04) */}
                        <button
                          className="delete-worker-btn"
                          onClick={() => killWorkerMidTask(worker.workerId)}
                          title="Simulate Crash Mid-Execution"
                          style={{ backgroundColor: "#e53e3e", color: "white" }}
                        >
                          ⚡ Kill
                        </button>

                        <button
                          className="delete-worker-btn"
                          onClick={() => deleteWorker(worker.workerId)}
                          title="Delete Worker from DB"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    <div className="worker-stats">
                      <span>
                        Failures <b>{worker.failureCount}</b>
                      </span>
                      <span>
                        Restarts <b>{worker.restartCount}</b>
                      </span>
                      <span>
                        Max <b>{worker.maxRestarts}</b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header">
                <h2>Event Stream</h2>
                <span>Live</span>
              </div>

              <div className="events">
                {events.slice(0, 30).map((event, index) => (
                  <div className="event" key={`${event.id}-${index}`}>
                    <span className="event-dot"></span>
                    <div>
                      <b>{event.type}</b>
                      {event.details && <span className="event-details">{event.details}</span>}
                      <small>{new Date(event.createdAt).toLocaleTimeString()}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <section className="panel tasks-panel">
            <div className="panel-header">
              <h2>Task Queue</h2>
              <span>{tasks.length} tasks</span>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Type</th>
                    <th>Payload</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Created</th>
                  </tr>
                </thead>

                <tbody>
                  {tasks
                    .slice()
                    .reverse()
                    .map((task) => (
                      <tr key={task.id}>
                        <td className="task-id">{task.id.substring(0, 8)}...</td>
                        <td>{task.type}</td>
                        <td>{task.payload}</td>
                        <td>
                          <span className={`badge ${getStatusClass(task.status)}`}>
                            {task.status}
                          </span>
                        </td>
                        <td>
                          {task.attemptCount}/{task.maxAttempts}
                        </td>
                        <td>{new Date(task.createdAt).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <footer>ORBIT • Real-time fault-tolerant orchestration</footer>
    </div>
  );
}

function Metric({
  title,
  value,
  danger = false,
}: {
  title: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className={`metric ${danger ? "metric-danger" : ""}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getStatusClass(status: string) {
  if (status === "COMPLETED" || status === "RUNNING") return "success";

  if (
    status === "DEAD_LETTER" ||
    status === "FAILED" ||
    status === "OUT_OF_SERVICE"
  ) {
    return "danger";
  }

  if (status === "RETRYING") return "warning";

  return "neutral";
}

export default App;
