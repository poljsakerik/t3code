// @effect-diagnostics nodeBuiltinImport:off -- Eve source discovery is a standalone Node API, independent of Effect.
/**
 * Adapted from vercel/eve, packages/eve/src/discover/discover-agent.ts
 * https://github.com/vercel/eve/blob/505601b3f448a20aecc133e5d132d70c2ec3ee35/packages/eve/src/discover/discover-agent.ts
 * Copyright 2026 Vercel, Inc. and contributors. Apache-2.0 (see ../LICENSE and ../NOTICE).
 * Modified for T3: retain explicit-root source discovery; report capabilities as
 * source entries without compiling them or resolving extensions; add an optional
 * source boundary. Consumers decide which capabilities their runtime supports.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { collectNamedSlotCandidates } from "./slots.ts";
import { classifyAgentRootEntry, getSupportedModuleBaseName } from "./filesystem.ts";
import {
  discoverFlatModuleSource,
  discoverInstructionsSource,
  readSortedDirectoryEntries,
} from "./grammar.ts";
import { createDiskProjectSource, type ProjectSource } from "./project-source.ts";

export interface AgentCapabilitySource {
  readonly slot: string;
  readonly logicalPath: string;
}
export interface AgentSkillSource {
  readonly name: string;
  readonly logicalPath: string;
  readonly sourceKind: "markdown" | "directory" | "module" | "other";
}

/** Discovers one authored agent folder, without importing executable sources. */
export async function discoverAgent(input: {
  readonly agentRoot: string;
  readonly boundaryRoot?: string;
  readonly source?: ProjectSource;
}) {
  let agentRoot = NodePath.resolve(input.agentRoot);
  let boundaryRoot =
    input.boundaryRoot === undefined ? undefined : NodePath.resolve(input.boundaryRoot);
  if (input.source === undefined && boundaryRoot !== undefined) {
    // Canonicalize the caller's workspace, while still rejecting a linked source root.
    const canonicalBoundary = NodePath.join(
      await NodeFSP.realpath(NodePath.dirname(boundaryRoot)),
      NodePath.basename(boundaryRoot),
    );
    agentRoot = NodePath.resolve(canonicalBoundary, NodePath.relative(boundaryRoot, agentRoot));
    boundaryRoot = canonicalBoundary;
  }
  const source =
    input.source ?? createDiskProjectSource(boundaryRoot === undefined ? {} : { boundaryRoot });
  const rootEntries = await readSortedDirectoryEntries(source, agentRoot);
  const configModule = discoverFlatModuleSource({
    rootEntries,
    rootPath: agentRoot,
    slotName: "agent",
  });
  const instructions = await discoverInstructionsSource({
    rootEntries,
    rootPath: agentRoot,
    source,
  });
  const connections: { readonly name: string; readonly logicalPath: string }[] = [];
  const connectionEntry = rootEntries.find((entry) => entry.name === "connections");
  if (connectionEntry !== undefined) {
    if (!connectionEntry.isDirectory()) throw new Error("Expected connections to be a directory.");
    const directory = NodePath.join(agentRoot, "connections");
    const entries = await readSortedDirectoryEntries(source, directory);
    for (const candidate of collectNamedSlotCandidates(entries, {
      allowMarkdown: false,
      allowModules: true,
    })) {
      if (candidate.moduleFileNames.length !== 1)
        throw new Error(`Conflicting connection modules: ${candidate.slotName}`);
      connections.push({
        name: candidate.slotName,
        logicalPath: NodePath.posix.join("connections", candidate.moduleFileNames[0]!),
      });
    }
    for (const entry of entries.filter((entry) => entry.isDirectory())) {
      if (connections.some((connection) => connection.name === entry.name))
        throw new Error(`Connection defined as both file and folder: ${entry.name}`);
      const rootPath = NodePath.join(directory, entry.name);
      const module = discoverFlatModuleSource({
        rootPath,
        rootEntries: await readSortedDirectoryEntries(source, rootPath),
        slotName: "connection",
      });
      if (module === undefined)
        throw new Error(`Connection folder ${entry.name} requires connection.ts.`);
      connections.push({
        name: entry.name,
        logicalPath: NodePath.posix.join("connections", entry.name, module.logicalPath),
      });
    }
    connections.sort((a, b) => a.name.localeCompare(b.name));
  }
  const capabilities: AgentCapabilitySource[] = [];
  const skills: AgentSkillSource[] = [];
  for (const entry of rootEntries) {
    const entryType = await source.stat(NodePath.join(agentRoot, entry.name));
    const kind = classifyAgentRootEntry(entry.name, entryType === "missing" ? "other" : entryType);
    if (kind === "memory-module") capabilities.push({ slot: "memory", logicalPath: entry.name });
    if (kind === "skills-directory") {
      for (const skill of await readSortedDirectoryEntries(
        source,
        NodePath.join(agentRoot, entry.name),
      )) {
        const logicalPath = NodePath.posix.join(entry.name, skill.name);
        const type = await source.stat(NodePath.join(agentRoot, logicalPath));
        const moduleName = getSupportedModuleBaseName(skill.name);
        const sourceKind =
          type === "directory"
            ? "directory"
            : type === "file" && skill.name.toLowerCase().endsWith(".md")
              ? "markdown"
              : type === "file" && moduleName !== null
                ? "module"
                : "other";
        skills.push({
          name:
            sourceKind === "markdown"
              ? skill.name.slice(0, -3)
              : sourceKind === "module"
                ? moduleName!
                : skill.name,
          logicalPath,
          sourceKind,
        });
      }
    } else if (
      entryType === "directory" &&
      ![
        "unknown",
        "ignored-directory",
        "instructions-directory",
        "subagents-directory",
        "connections-directory",
      ].includes(kind)
    ) {
      for (const child of await source.readDirectory(NodePath.join(agentRoot, entry.name))) {
        capabilities.push({
          slot: entry.name,
          logicalPath: NodePath.posix.join(entry.name, child.name),
        });
      }
    }
  }
  return { agentRoot, configModule, instructions, skills, connections, capabilities };
}

export type AgentSourceManifest = Awaited<ReturnType<typeof discoverAgent>>;
