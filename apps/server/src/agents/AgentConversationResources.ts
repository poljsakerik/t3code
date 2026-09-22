import { resolveAttachmentPath } from "../attachmentStore.ts";
import { AgentDefinitionError, type ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const isAgentDefinitionError = Schema.is(AgentDefinitionError);

/** Retain only a selected skill package, never the agent's authoring workspace. */
export const retainAgentSkill = Effect.fn("retainAgentSkill")(function* (
  sourceDirectory: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const copy = (source: string, target: string): Effect.Effect<void, AgentDefinitionError> =>
    Effect.gen(function* () {
      // Reject symlinks instead of following them into another package or workspace.
      if ((yield* fs.realPath(source)) !== source) {
        return yield* new AgentDefinitionError({
          path: source,
          message: "Conversation skills cannot contain symbolic links or external resources.",
        });
      }
      const stat = yield* fs.stat(source);
      if (stat.type === "Directory") {
        yield* fs.makeDirectory(target, { recursive: true });
        for (const name of yield* fs.readDirectory(source)) {
          yield* copy(path.join(source, name), path.join(target, name));
        }
      } else if (stat.type === "File") {
        yield* fs.copyFile(source, target);
      } else {
        return yield* new AgentDefinitionError({
          path: source,
          message: "Conversation skills support only regular files and directories.",
        });
      }
    }).pipe(
      Effect.mapError((cause) =>
        isAgentDefinitionError(cause)
          ? cause
          : new AgentDefinitionError({
              path: source,
              message: "Could not retain this conversation's skill resources.",
              cause,
            }),
      ),
    );
  yield* copy(sourceDirectory, destination);
  return destination;
});

/** Expose only attachments sent to this conversation inside its provider sandbox. */
export const retainConversationAttachments = Effect.fn("retainConversationAttachments")(function* (
  fs: FileSystem.FileSystem,
  attachments: ReadonlyArray<ChatAttachment>,
  attachmentsDir: string,
  directory: string,
) {
  const destination = `${directory}/attachments`;
  yield* fs.makeDirectory(destination, { recursive: true });
  const canonicalRoot = (yield* fs.realPath(directory)).replaceAll("\\", "/");
  const canonicalDestination = (yield* fs.realPath(destination)).replaceAll("\\", "/");
  if (canonicalDestination !== `${canonicalRoot}/attachments`) {
    return yield* new AgentDefinitionError({
      message: "The conversation attachment directory must not be a symbolic link.",
    });
  }
  for (const attachment of attachments) {
    const source = resolveAttachmentPath({ attachmentsDir, attachment });
    const target = resolveAttachmentPath({ attachmentsDir: destination, attachment });
    if (source === null || target === null) {
      return yield* new AgentDefinitionError({
        message: `Invalid conversation attachment: ${attachment.name}`,
      });
    }
    yield* fs.remove(target, { force: true });
    yield* fs.copyFile(source, target);
  }
  return destination;
});
