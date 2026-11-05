import type { RoutineRun } from "@office/contracts";
import type { RoutineLog } from "@office/engine";

type Row = { id: string; routine: string; trigger: string; started_at: string; finished_at: string; outcome: string; summary: string; counts: string; error: string | null };

const toRun = (r: Row): RoutineRun => ({
  id: r.id,
  routine: r.routine,
  trigger: r.trigger as RoutineRun["trigger"],
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  outcome: r.outcome as RoutineRun["outcome"],
  summary: r.summary,
  counts: JSON.parse(r.counts || "{}") as Record<string, number>,
  error: r.error,
});

/** Each routine's runs in the office's own SQLite; a pause is a flag in office_kv. */
export class SqlRoutineLog implements RoutineLog {
  constructor(private sql: SqlStorage) {
    sql.exec(
      "CREATE TABLE IF NOT EXISTS routine_run (id TEXT PRIMARY KEY, routine TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL, counts TEXT NOT NULL, error TEXT)",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS routine_run_by_routine ON routine_run (routine, started_at)");
  }

  record(run: RoutineRun) {
    this.sql.exec(
      "INSERT OR REPLACE INTO routine_run (id, routine, trigger, started_at, finished_at, outcome, summary, counts, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      run.id,
      run.routine,
      run.trigger,
      run.startedAt,
      run.finishedAt,
      run.outcome,
      run.summary.slice(0, 2000),
      JSON.stringify(run.counts),
      run.error,
    );
  }

  runs(routine: string, limit: number) {
    return this.sql.exec<Row>("SELECT * FROM routine_run WHERE routine = ? ORDER BY started_at DESC LIMIT ?", routine, limit).toArray().map(toRun);
  }

  last(routine: string) {
    return this.runs(routine, 1)[0] ?? null;
  }

  since(routine: string, fromIso: string) {
    return this.sql.exec<Row>("SELECT * FROM routine_run WHERE routine = ? AND started_at >= ? ORDER BY started_at DESC", routine, fromIso).toArray().map(toRun);
  }

  paused(routine: string) {
    return this.sql.exec<{ v: string }>("SELECT v FROM office_kv WHERE k = ?", `routine:paused:${routine}`).toArray()[0]?.v === "1";
  }

  setPaused(routine: string, paused: boolean) {
    if (paused) this.sql.exec("INSERT INTO office_kv (k, v) VALUES (?, '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v", `routine:paused:${routine}`);
    else this.sql.exec("DELETE FROM office_kv WHERE k = ?", `routine:paused:${routine}`);
  }

  prune(beforeIso: string) {
    const n = Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM routine_run WHERE started_at < ?", beforeIso).toArray()[0]?.n ?? 0);
    if (n) this.sql.exec("DELETE FROM routine_run WHERE started_at < ?", beforeIso);
    return n;
  }
}
