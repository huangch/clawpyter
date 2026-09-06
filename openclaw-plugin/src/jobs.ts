// Async execution jobs — fire-and-forget wrappers around the Jupyter WebSocket
// kernel channels. The default tools (`jupyter_execute_code` etc.) block until
// the kernel returns execute_reply, which means a long-running cell pins the
// agent session. The async path returns immediately with a `job_id`; the agent
// polls via `jupyter_get_job_result` / `jupyter_list_jobs` and cancels via
// `jupyter_cancel_job`.
//
// Module-level state (Map<jobId, JobState>) intentionally lives at module scope
// rather than in JupyterDirectClient so it survives server reconnects (a fresh
// JupyterDirectClient after `jupyter_connect_to_jupyter` still sees in-flight
// jobs and can stream their outputs as they resolve on the original kernel).

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface OutputChunk {
  stream: "stdout" | "stderr" | "result" | "display" | "error";
  text: string;
  mime?: string;
  execution_count?: number | null;
}

export interface JobState {
  id: string;
  notebookName: string | null;
  kernelId: string;
  code: string;
  /** The cell whose outputs we wrote back, if any (jupyter_execute_cell family). */
  persistCellIndex: number | null;
  /** Path of the notebook this job was attached to. */
  notebookPath: string | null;
  status: JobStatus;
  startedAt: number; // epoch ms
  endedAt: number | null;
  outputs: OutputChunk[];
  errorMessage: string | null;
}

const _JOBS = new Map<string, JobState>();
const _JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes after completion

function _cleanup(): void {
  const now = Date.now();
  for (const [id, job] of _JOBS.entries()) {
    if (job.status === "running" || job.status === "queued") continue;
    if (job.endedAt !== null && now - job.endedAt > _JOB_TTL_MS) {
      _JOBS.delete(id);
    }
  }
}

export function registerJob(state: JobState): void {
  _cleanup();
  _JOBS.set(state.id, state);
}

export function getJob(id: string): JobState | null {
  return _JOBS.get(id) ?? null;
}

export function listJobs(): JobState[] {
  _cleanup();
  return Array.from(_JOBS.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteJob(id: string): void {
  _JOBS.delete(id);
}

/**
 * Mark a job terminal. Called from the executeCodeAsync coroutine when
 * execute_reply lands or the WebSocket closes/errors.
 */
export function finalize(
  id: string,
  status: JobStatus,
  errorMessage: string | null,
): void {
  const job = _JOBS.get(id);
  if (!job) return;
  job.status = status;
  job.endedAt = Date.now();
  if (errorMessage !== null) job.errorMessage = errorMessage;
}

export function summarise(job: JobState): string {
  const age = Math.round((Date.now() - job.startedAt) / 1000);
  const lines = [
    `## Job ${job.id}`,
    `status        : ${job.status}`,
    `kernel        : ${job.kernelId}`,
    `notebook      : ${job.notebookPath ?? "(detached)"}`,
    `started       : ${age}s ago`,
    `code_preview  : ${job.code.length > 80 ? job.code.slice(0, 80) + "..." : job.code}`,
    `outputs       : ${job.outputs.length} chunk(s) accumulated`,
  ];
  if (job.endedAt !== null) {
    lines.push(`ended         : ${Math.round((job.endedAt - job.startedAt) / 1000)}s after start`);
  }
  if (job.errorMessage) {
    lines.push(`error         : ${job.errorMessage.slice(0, 400)}`);
  }
  return lines.join("\n");
}

/** Format accumulated outputs as plain text (one chunk per line). */
export function formatJobOutputs(job: JobState): string {
  return job.outputs
    .map((o) => {
      const tag = o.stream === "stderr" ? "STDERR" : o.stream.toUpperCase();
      return `[${tag}] ${o.text}`;
    })
    .join("\n");
}
