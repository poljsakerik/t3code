// @effect-diagnostics nodeBuiltinImport:off -- Eve source discovery is a standalone Node API, independent of Effect.
/**
 * Copied and adapted from vercel/eve, packages/eve/src/discover/grammar.ts
 * https://github.com/vercel/eve/blob/505601b3f448a20aecc133e5d132d70c2ec3ee35/packages/eve/src/discover/grammar.ts
 * Copyright 2026 Vercel, Inc. and contributors. Apache-2.0 (see ../LICENSE and ../NOTICE).
 * Modified for T3: retain instruction/flat-module discovery; throw source errors
 * instead of compiler diagnostics; inline non-recursive named instruction discovery.
 */
import * as NodePath from "node:path";
import type { ProjectSource, ProjectSourceEntry } from "./project-source.ts";
import { collectFlatSlotCandidates, collectNamedSlotCandidates } from "./slots.ts";

export interface ModuleSourceRef {
  readonly sourceKind: "module";
  readonly logicalPath: string;
}
export interface MarkdownSourceRef {
  readonly sourceKind: "markdown";
  readonly logicalPath: string;
  readonly definition: { readonly content: string; readonly role: "system" };
}
export type InstructionsSourceRef = ModuleSourceRef | MarkdownSourceRef;

export async function readSortedDirectoryEntries(source: ProjectSource, directoryPath: string) {
  const entries = [...(await source.readDirectory(directoryPath))];
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

/** Flat instructions precede named instructions; legacy system is only a fallback. */
export async function discoverInstructionsSource(input: {
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
}): Promise<InstructionsSourceRef[]> {
  const hasDirectory = input.rootEntries.some((e) => e.name === "instructions" && e.isDirectory());
  const flatSource = await discoverSlotSource({
    markdownFileName: "instructions.md",
    moduleBaseName: "instructions",
    ...input,
  });
  if (hasDirectory) {
    const directory = NodePath.join(input.rootPath, "instructions");
    const entries = await readSortedDirectoryEntries(input.source, directory);
    const instructions: InstructionsSourceRef[] = [];
    if (flatSource !== undefined) instructions.push(flatSource);
    for (const candidates of collectNamedSlotCandidates(entries, {
      allowMarkdown: true,
      allowModules: true,
    })) {
      const source = await lowerSlotSource(
        candidates,
        input.source,
        input.rootPath,
        "instructions",
      );
      if (source !== undefined) instructions.push(source);
    }
    return instructions;
  }
  if (flatSource !== undefined) return [flatSource];
  const legacySource = await discoverSlotSource({
    markdownFileName: "system.md",
    moduleBaseName: "system",
    ...input,
  });
  return legacySource === undefined ? [] : [legacySource];
}

async function discoverSlotSource(input: {
  markdownFileName: string;
  moduleBaseName: string;
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  source: ProjectSource;
}): Promise<InstructionsSourceRef | undefined> {
  const candidates = collectFlatSlotCandidates(input.rootEntries, input);
  return lowerSlotSource(candidates, input.source, input.rootPath, "");
}

async function lowerSlotSource(
  candidates: { markdownFileName?: string; moduleFileNames: readonly string[] },
  source: ProjectSource,
  rootPath: string,
  directory: string,
): Promise<InstructionsSourceRef | undefined> {
  if (
    (candidates.markdownFileName !== undefined && candidates.moduleFileNames.length > 0) ||
    candidates.moduleFileNames.length > 1
  ) {
    throw new Error(
      `Conflicting authored agent instruction sources in ${NodePath.join(rootPath, directory)}.`,
    );
  }
  if (candidates.markdownFileName !== undefined) {
    const logicalPath = NodePath.posix.join(directory, candidates.markdownFileName);
    return {
      sourceKind: "markdown",
      logicalPath,
      definition: {
        content: await source.readTextFile(NodePath.join(rootPath, logicalPath)),
        role: "system",
      },
    };
  }
  const [fileName] = candidates.moduleFileNames;
  return fileName === undefined
    ? undefined
    : {
        sourceKind: "module",
        logicalPath: NodePath.posix.join(directory, fileName),
      };
}

/** Discovers one flat module slot without importing the authored module. */
export function discoverFlatModuleSource(input: {
  rootEntries: readonly ProjectSourceEntry[];
  rootPath: string;
  slotName: string;
}): ModuleSourceRef | undefined {
  const candidates = collectFlatSlotCandidates(input.rootEntries, {
    moduleBaseName: input.slotName,
  });
  if (candidates.moduleFileNames.length > 1) {
    throw new Error(
      `Expected exactly one authored module for ${input.slotName} in ${input.rootPath}.`,
    );
  }
  const [logicalPath] = candidates.moduleFileNames;
  return logicalPath === undefined ? undefined : { sourceKind: "module", logicalPath };
}
