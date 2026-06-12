import Database from 'better-sqlite3';

export type ControlState = 'running' | 'stopping';

/**
 * A single-row control flag. Lets `loom stop` (a separate process) signal a
 * running supervisor to halt gracefully — the supervisor polls the state
 * between dispatch decisions.
 */
export class ControlStore {
  constructor(private db: Database.Database) {}

  getState(): ControlState {
    const row = this.db
      .prepare('SELECT state FROM loom_control WHERE id = 1')
      .get() as { state: string } | undefined;
    return row?.state === 'stopping' ? 'stopping' : 'running';
  }

  setState(state: ControlState): void {
    this.db
      .prepare(
        `INSERT INTO loom_control (id, state) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state`
      )
      .run(state);
  }
}
