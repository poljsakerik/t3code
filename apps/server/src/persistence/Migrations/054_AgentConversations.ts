import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Replacing this indexed column keeps every other projection column and index intact.
  yield* sql`DROP INDEX orchestration_v2_projection_threads_project_updated_idx`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads RENAME COLUMN project_id TO previous_project_id`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads ADD COLUMN project_id TEXT`;
  yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = previous_project_id`;
  yield* sql`ALTER TABLE orchestration_v2_projection_threads DROP COLUMN previous_project_id`;
  yield* sql`CREATE INDEX orchestration_v2_projection_threads_project_updated_idx
    ON orchestration_v2_projection_threads(project_id, updated_at)`;
  yield* sql`CREATE INDEX orchestration_v2_projection_threads_agent_updated_idx
    ON orchestration_v2_projection_threads(
      json_extract(payload_json, '$.agent.owner.sourceProjectId'),
      json_extract(payload_json, '$.agent.owner.agentId'), updated_at)
    WHERE project_id IS NULL`;
});
