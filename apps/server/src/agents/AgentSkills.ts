import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { PlatformError } from "effect/PlatformError";
import {
  AgentDefinitionError,
  AgentSkillSearchResult,
  type AgentSkillSearchInput,
  type AgentSkillInstallInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProcessRunner } from "../processRunner.ts";

const isAgentDefinitionError = Schema.is(AgentDefinitionError);
const isSkill = Schema.is(AgentSkillSearchResult.fields.skills.value);
const decodeSearchResponse = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ skills: Schema.Array(Schema.Unknown) }),
);

// This is the public endpoint used by the open-source skills CLI. Keep its
// response boundary here; the separately versioned API requires Vercel OIDC.
export const searchAgentSkills = Effect.fn("searchAgentSkills")(
  function* (input: AgentSkillSearchInput) {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get("https://skills.sh/api/search", {
      urlParams: { q: input.query, limit: "20" },
    });
    const data = yield* decodeSearchResponse(response);
    return {
      skills: data.skills
        .filter(isSkill)
        .slice(0, 20)
        .map(({ name, source, installs }) => ({ name, source, installs })),
    };
  },
  Effect.timeout("15 seconds"),
  Effect.mapError(
    (cause) =>
      new AgentDefinitionError({
        message: "Could not search skills.sh. Try again or add a skill from its GitHub repository.",
        cause,
      }),
  ),
);

/** Downloads into disposable staging; the CLI never receives an agent or project directory. */
export const downloadAgentSkill = Effect.fn("downloadAgentSkill")(
  function* (input: Pick<AgentSkillInstallInput, "source" | "name">) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner;
    const temporary = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-agent-skill-" })
      .pipe(Effect.flatMap(fs.realPath));
    const result = yield* runner.run({
      command: "npx",
      args: [
        "--yes",
        "skills@1.7.0",
        "add",
        input.source,
        "--skill",
        input.name,
        "--agent",
        "codex",
        "--copy",
        "--yes",
      ],
      cwd: temporary,
      env: { ...process.env, DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" },
      timeout: "2 minutes",
      maxOutputBytes: 64 * 1024,
      outputMode: "truncate",
    });
    if (result.code !== 0) {
      return yield* new AgentDefinitionError({
        message:
          "Could not download this skill. Check the repository and skill name, and make sure Node.js, npm and Git are available on the environment.",
      });
    }
    const directory = path.join(temporary, ".agents", "skills", input.name);
    // Refuse linked payloads before copying them into an authored agent.
    const validate = Effect.fn("downloadAgentSkill.validate")(function* (
      file: string,
    ): Effect.fn.Return<void, PlatformError | AgentDefinitionError> {
      if ((yield* fs.realPath(file)) !== file) {
        return yield* new AgentDefinitionError({
          message: "Skill packages containing symbolic links are not supported.",
        });
      }
      const info = yield* fs.stat(file);
      if (info.type === "Directory") {
        for (const child of yield* fs.readDirectory(file)) yield* validate(path.join(file, child));
      } else if (info.type !== "File") {
        return yield* new AgentDefinitionError({
          message: "Skill packages may contain only files and directories.",
        });
      }
    });
    yield* validate(directory);
    const document = path.join(directory, "SKILL.md");
    if (
      (yield* fs.stat(document)).type !== "File" ||
      (yield* fs.stat(document)).size > 1_000_000n ||
      !(yield* fs.readFileString(document)).trim()
    ) {
      return yield* new AgentDefinitionError({
        message: "The selected skill has no SKILL.md instructions.",
      });
    }
    return directory;
  },
  Effect.mapError((cause) =>
    isAgentDefinitionError(cause)
      ? cause
      : new AgentDefinitionError({
          message:
            "Could not download the skill. Check Node.js, npm, Git and network access on the environment.",
          cause,
        }),
  ),
);
