import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { retainAgentSkill, retainConversationAttachments } from "./AgentConversationResources.ts";
import { discoverAgentDefinitions } from "./AgentDefinitionService.ts";
import { loadAgentDefinition } from "./AgentDefinitionLoader.ts";

import { resolveAttachmentPath } from "../attachmentStore.ts";

it.layer(NodeServices.layer)("agent conversation resources", (it) => {
  it.effect("keeps packaged instructions and resources after the source is edited or removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-conversation-" });
      const source = yield* fs.realPath(root);
      const agent = path.join(source, ".t3/agents/writer");
      const skill = path.join(agent, "skills/writing");
      const destination = path.join(source, "retained/writing");
      yield* fs.makeDirectory(path.join(skill, "references"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agent, "agent.ts"),
        'export default { model: "anthropic/claude-sonnet-4-6" };',
      );
      yield* fs.writeFileString(path.join(agent, "instructions.md"), "Write clearly.");
      yield* fs.writeFileString(path.join(skill, "SKILL.md"), "Consult references/style.md.");
      yield* fs.writeFileString(path.join(skill, "references/style.md"), "Use concrete examples.");
      const definition = (yield* discoverAgentDefinitions(source))[0]!;
      const snapshot = yield* loadAgentDefinition(source, definition, {
        retainSkill: (directory) =>
          retainAgentSkill(directory, destination).pipe(Effect.provide(NodeServices.layer)),
      });
      yield* fs.remove(agent, { recursive: true });
      assert.include(snapshot.instructions, destination);
      assert.notInclude(snapshot.instructions, agent);
      assert.equal(snapshot.modelSelection.instanceId, "claudeAgent");
      assert.equal(
        yield* fs.readFileString(path.join(destination, "references/style.md")),
        "Use concrete examples.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("copies only the conversation's selected attachments into its directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-attachments-" });
      const attachmentsDir = path.join(root, "uploads");
      const directory = path.join(root, "conversation");
      yield* fs.makeDirectory(attachmentsDir);
      yield* fs.makeDirectory(directory);
      const attachment = {
        type: "file" as const,
        id: "writer-12345678-1234-1234-1234-123456789abc-txt",
        name: "draft.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      };
      const source = resolveAttachmentPath({ attachmentsDir, attachment })!;
      yield* fs.writeFileString(source, "draft");
      yield* fs.writeFileString(path.join(attachmentsDir, "other-private.txt"), "unrelated");
      const retained = yield* retainConversationAttachments(
        fs,
        [attachment],
        attachmentsDir,
        directory,
      );
      assert.equal(
        yield* fs.readFileString(resolveAttachmentPath({ attachmentsDir: retained, attachment })!),
        "draft",
      );
      assert.equal((yield* fs.readDirectory(retained)).length, 1);
      assert.isFalse(yield* fs.exists(path.join(retained, "other-private.txt")));
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a skill resource that escapes its package through a symbolic link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-link-" });
      const source = yield* fs.realPath(root);
      yield* fs.makeDirectory(path.join(source, "skill"));
      yield* fs.writeFileString(path.join(source, "private.md"), "Unrelated project data");
      yield* fs.symlink(path.join(source, "private.md"), path.join(source, "skill/reference.md"));
      const result = yield* retainAgentSkill(
        path.join(source, "skill"),
        path.join(source, "retained"),
      ).pipe(Effect.flip);
      assert.include(result.message, "symbolic links");
      assert.isFalse(yield* fs.exists(path.join(source, "retained/reference.md")));
    }).pipe(Effect.scoped),
  );
});
