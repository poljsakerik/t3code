/**
 * Copied from vercel/eve, packages/eve/src/discover/filesystem.ts
 * https://github.com/vercel/eve/blob/7973fa2d7d10e285737536672cfcfe64ceff37c8/packages/eve/src/discover/filesystem.ts
 * Copyright 2026 Vercel, Inc. and contributors. Apache-2.0 (see ../LICENSE and ../NOTICE).
 * Modified for T3: retained only agent-root classification and module-name helpers;
 * exported the module-name matcher for catalog metadata. No modules are executed.
 */
export const SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS = [
  ".cts",
  ".mts",
  ".cjs",
  ".mjs",
  ".ts",
  ".js",
] as const;

const GENERATED_AGENT_DIRECTORY_NAMES = new Set<string>([
  ".devtools",
  ".eve",
  ".next",
  ".output",
  ".vercel",
  "node_modules",
]);

/**
 * Filesystem entry type used by discovery classifiers.
 */
export type DirectoryEntryType = "directory" | "file" | "other";

/**
 * Classified root-level agent entry.
 */
export type AgentRootEntryKind =
  | "agent-config-module"
  | "channels-directory"
  | "connections-directory"
  | "extensions-directory"
  | "hooks-directory"
  | "ignored-directory"
  | "instrumentation-directory"
  | "instructions-directory"
  | "instructions-markdown"
  | "instructions-module"
  | "lib-directory"
  | "memory-directory"
  | "memory-module"
  | "sandbox-directory"
  | "schedules-directory"
  | "skills-directory"
  | "system-markdown"
  | "system-module"
  | "tools-directory"
  | "unknown"
  | "subagents-directory";

export function isDiscoverableAgentRootEntry(name: string, entryType: DirectoryEntryType): boolean {
  const kind = classifyAgentRootEntry(name, entryType);
  return (
    kind !== "unknown" &&
    kind !== "ignored-directory" &&
    kind !== "lib-directory" &&
    kind !== "memory-directory"
  );
}

export function classifyAgentRootEntry(
  name: string,
  entryType: DirectoryEntryType,
): AgentRootEntryKind {
  if (entryType === "file") {
    if (matchesSupportedModuleBaseName(name, "agent")) {
      return "agent-config-module";
    }

    if (name.toLowerCase() === "instructions.md") {
      return "instructions-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "instructions")) {
      return "instructions-module";
    }

    if (matchesSupportedModuleBaseName(name, "memory")) return "memory-module";

    if (name.toLowerCase() === "system.md") {
      return "system-markdown";
    }

    if (matchesSupportedModuleBaseName(name, "system")) {
      return "system-module";
    }

    return "unknown";
  }

  if (entryType === "directory") {
    if (GENERATED_AGENT_DIRECTORY_NAMES.has(name)) {
      return "ignored-directory";
    }

    if (name === "channels") {
      return "channels-directory";
    }

    if (name === "connections") {
      return "connections-directory";
    }

    if (name === "extensions") {
      return "extensions-directory";
    }

    if (name === "hooks") {
      return "hooks-directory";
    }

    if (name === "instructions") {
      return "instructions-directory";
    }

    if (name === "instrumentation") {
      return "instrumentation-directory";
    }

    if (name === "lib") {
      return "lib-directory";
    }

    if (name === "memory") return "memory-directory";

    if (name === "skills") {
      return "skills-directory";
    }

    if (name === "sandbox") {
      return "sandbox-directory";
    }

    if (name === "tools") {
      return "tools-directory";
    }

    if (name === "schedules") {
      return "schedules-directory";
    }

    if (name === "subagents") {
      return "subagents-directory";
    }
  }

  return "unknown";
}

export function getSupportedModuleBaseName(name: string): string | null {
  if (isTypeScriptDeclarationFileName(name)) {
    return null;
  }

  for (const extension of SUPPORTED_AUTHORED_MODULE_FILE_EXTENSIONS) {
    if (name.endsWith(extension) && name.length > extension.length) {
      return name.slice(0, -extension.length);
    }
  }

  return null;
}

/** Returns whether a filename is a TypeScript declaration module. */
export function isTypeScriptDeclarationFileName(name: string): boolean {
  return /\.d\.(?:cts|mts|ts)$/.test(name);
}

export function matchesSupportedModuleBaseName(name: string, baseName: string): boolean {
  return getSupportedModuleBaseName(name) === baseName;
}
