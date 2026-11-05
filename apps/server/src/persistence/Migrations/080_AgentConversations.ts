import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Agent conversations belong to an agent rather than a project, so a thread's project is optional.
// Fork builds once ran this as migration 57; skip when that run already made the column nullable.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
    PRAGMA table_info(orchestration_v2_projection_threads)
  `;
  if (columns.find((column) => column.name === "project_id")?.notnull !== 1) return;
  // Replacing this indexed column keeps every other projection column and index intact.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_project_updated_idx`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads RENAME COLUMN project_id TO previous_project_id`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
  yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = previous_project_id`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads DROP COLUMN previous_project_id`;
  yield* sql`CREATE INDEX orchestration_v2_projection_threads_project_updated_idx
    ON orchestration_v2_projection_threads(project_id, updated_at)`;
});
