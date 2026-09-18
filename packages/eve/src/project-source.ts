// @effect-diagnostics nodeBuiltinImport:off -- Eve source discovery is a standalone Node API, independent of Effect.
/**
 * Copied and adapted from vercel/eve, packages/eve/src/discover/project-source.ts
 * https://github.com/vercel/eve/blob/505601b3f448a20aecc133e5d132d70c2ec3ee35/packages/eve/src/discover/project-source.ts
 * Copyright 2026 Vercel, Inc. and contributors. Apache-2.0 (see ../LICENSE and ../NOTICE).
 * Modified for T3: optional source boundary and symlink checks; preserve non-missing I/O errors; namespace Node imports.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Minimum directory-entry shape returned by a {@link ProjectSource}.
 *
 * Intentionally matches the subset of `node:fs` `Dirent` methods discovery
 * actually reads: `name` and the structural type predicates. The matching
 * shape lets {@link DiskProjectSource} return real `Dirent<string>` values
 * without an adapter wrapper, while {@link MemoryProjectSource} can return
 * lightweight plain objects.
 */
export interface ProjectSourceEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Result of a filesystem-style stat against a {@link ProjectSource}.
 *
 * - `directory` / `file`: the path resolves to one of those kinds.
 * - `missing`: the path does not exist in the source.
 * - `other`: the path exists but is neither a directory nor a regular file
 *   (symlink, socket, device). Discovery treats this identically to
 *   `missing` in most places but keeps the distinction for diagnostics.
 */
export type ProjectSourceEntryKind = "directory" | "file" | "missing" | "other";

/**
 * Abstraction over the filesystem root discovery reads from.
 *
 * Every read performed by `src/discover/**` goes through a `ProjectSource`
 * rather than `node:fs` directly. Production callers use
 * {@link createDiskProjectSource} — a one-line wrapper around `node:fs` that
 * preserves existing behaviour. Tests can swap in
 * {@link createMemoryProjectSource} to run discovery against an in-memory
 * tree without touching disk, `mkdtemp`, or any fixture copying.
 *
 * The interface is intentionally small: discovery needs to read directory
 * entries, read UTF-8 text files, and classify paths by kind. Nothing more.
 */
export interface ProjectSource {
  /**
   * Diagnostic label for this source (e.g. `"disk"` or `"memory"`).
   * Used only for logs and error messages.
   */
  readonly kind: "disk" | "memory";
  /**
   * Returns the entries of `directoryPath` without any intrinsic ordering.
   * Callers that require stable ordering should sort explicitly.
   *
   * Throws when the path does not resolve to a directory — callers that
   * want "missing is OK" should stat first.
   */
  readDirectory(directoryPath: string): Promise<readonly ProjectSourceEntry[]>;
  /**
   * Returns the UTF-8 text content of `filePath`. Throws when the path is
   * missing or is not a regular file.
   */
  readTextFile(filePath: string): Promise<string>;
  /**
   * Returns the kind of `targetPath` without throwing for missing paths.
   */
  stat(targetPath: string): Promise<ProjectSourceEntryKind>;
}

/**
 * Creates a {@link ProjectSource} backed by the real filesystem. This is the
 * default for production and for the scenario tier.
 */
export function createDiskProjectSource(
  options: { readonly boundaryRoot?: string } = {},
): ProjectSource {
  const assertPath = async (targetPath: string) => {
    if (options.boundaryRoot === undefined) return;
    const relative = NodePath.relative(options.boundaryRoot, targetPath);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    ) {
      throw new Error(`Agent source path must be inside ${options.boundaryRoot}: ${targetPath}`);
    }
    if ((await NodeFSP.realpath(targetPath)) !== NodePath.resolve(targetPath)) {
      throw new Error(`Agent source paths must not contain symbolic links: ${targetPath}`);
    }
  };
  return {
    kind: "disk",
    async readDirectory(directoryPath) {
      await assertPath(directoryPath);
      const entries = await NodeFSP.readdir(directoryPath, { withFileTypes: true });
      if (options.boundaryRoot !== undefined) {
        await Promise.all(
          entries.map((entry) => assertPath(NodePath.join(directoryPath, entry.name))),
        );
      }
      return entries;
    },
    async readTextFile(filePath) {
      await assertPath(filePath);
      return await NodeFSP.readFile(filePath, "utf8");
    },
    async stat(targetPath) {
      try {
        const stats = await NodeFSP.lstat(targetPath);
        await assertPath(targetPath);

        if (stats.isDirectory()) {
          return "directory";
        }

        if (stats.isFile()) {
          return "file";
        }

        return "other";
      } catch (error) {
        if (
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return "missing";
        throw error;
      }
    },
  };
}

/**
 * Declarative descriptor of an in-memory directory tree consumed by
 * {@link createMemoryProjectSource}.
 *
 * Keys are paths; values are UTF-8 text or `{ content }` records.
 */
export interface MemoryProjectSourceInput {
  /**
   * Optional root hint used only for diagnostics. The source itself accepts
   * reads against any path — unrelated absolute paths simply resolve as
   * missing.
   */
  readonly rootDir?: string;
  /**
   * Map of absolute paths to file content.
   */
  readonly files: Readonly<Record<string, string | { readonly content: string }>>;
  /**
   * Optional list of absolute paths that should exist as directories even
   * though no files live underneath them. Discovery treats these exactly
   * like real empty folders on disk — they appear in `readDirectory`
   * listings of their parent and return `"directory"` from `stat`.
   *
   * Every parent of every file in {@link files} is already registered as
   * a directory automatically, so this field is only needed for empty
   * folders (for example, to assert that an empty `connections/` folder
   * produces no diagnostics).
   */
  readonly directories?: readonly string[];
}

/**
 * Creates a {@link ProjectSource} backed by an in-memory file tree.
 *
 * Directories are inferred from the set of file paths: every parent of
 * every file is treated as a directory, and directory listings return the
 * immediate children. This matches the shape of real filesystems closely
 * enough for all discovery code paths.
 */
export function createMemoryProjectSource(input: MemoryProjectSourceInput): ProjectSource {
  const filesByNormalizedPath = new Map<string, string>();
  const directoriesByNormalizedPath = new Map<string, Map<string, "file" | "directory">>();

  function registerDirectory(normalizedDirectoryPath: string): Map<string, "file" | "directory"> {
    let entries = directoriesByNormalizedPath.get(normalizedDirectoryPath);

    if (entries === undefined) {
      entries = new Map();
      directoriesByNormalizedPath.set(normalizedDirectoryPath, entries);
    }

    return entries;
  }

  function registerChildOfDirectory(
    normalizedDirectoryPath: string,
    childName: string,
    childKind: "file" | "directory",
  ): void {
    const existing = registerDirectory(normalizedDirectoryPath).get(childName);
    if (existing === "file" && childKind === "directory") {
      throw new TypeError(
        `MemoryProjectSource: path "${NodePath.posix.join(normalizedDirectoryPath, childName)}" registered as both a file and a directory.`,
      );
    }
    registerDirectory(normalizedDirectoryPath).set(childName, childKind);
  }

  for (const [rawPath, value] of Object.entries(input.files)) {
    const normalizedPath = normalizeToPosix(rawPath);
    const content = typeof value === "string" ? value : value.content;

    filesByNormalizedPath.set(normalizedPath, content);

    const segments = splitPosixPath(normalizedPath);

    if (segments.length === 0) {
      throw new TypeError(`MemoryProjectSource: cannot register root path "${rawPath}" as a file.`);
    }

    const fileName = segments[segments.length - 1];

    if (fileName === undefined) {
      throw new TypeError(`MemoryProjectSource: empty file name in "${rawPath}".`);
    }

    let currentDirectoryPath = "/";

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];

      if (segment === undefined) {
        continue;
      }

      registerChildOfDirectory(currentDirectoryPath, segment, "directory");
      currentDirectoryPath =
        currentDirectoryPath === "/" ? `/${segment}` : `${currentDirectoryPath}/${segment}`;
    }

    registerChildOfDirectory(currentDirectoryPath, fileName, "file");
  }

  for (const rawDirectoryPath of input.directories ?? []) {
    const normalizedDirectoryPath = normalizeToPosix(rawDirectoryPath);
    const directorySegments = splitPosixPath(normalizedDirectoryPath);

    registerDirectory(normalizedDirectoryPath);

    let ancestorDirectoryPath = "/";

    for (let index = 0; index < directorySegments.length; index += 1) {
      const segment = directorySegments[index];

      if (segment === undefined) {
        continue;
      }

      registerChildOfDirectory(ancestorDirectoryPath, segment, "directory");
      ancestorDirectoryPath =
        ancestorDirectoryPath === "/" ? `/${segment}` : `${ancestorDirectoryPath}/${segment}`;
    }
  }

  return {
    kind: "memory",
    async readDirectory(directoryPath) {
      const normalized = normalizeToPosix(directoryPath);
      const entries = directoriesByNormalizedPath.get(normalized);

      if (entries === undefined) {
        throw new Error(
          `MemoryProjectSource: directory "${directoryPath}" does not exist${
            input.rootDir === undefined ? "" : ` (root: ${input.rootDir})`
          }.`,
        );
      }

      return [...entries.entries()].map(([name, kind]) => createMemoryEntry(name, kind));
    },
    async readTextFile(filePath) {
      const normalized = normalizeToPosix(filePath);
      const content = filesByNormalizedPath.get(normalized);

      if (content === undefined) {
        throw new Error(
          `MemoryProjectSource: file "${filePath}" does not exist${
            input.rootDir === undefined ? "" : ` (root: ${input.rootDir})`
          }.`,
        );
      }

      return content;
    },
    async stat(targetPath) {
      const normalized = normalizeToPosix(targetPath);

      if (filesByNormalizedPath.has(normalized)) {
        return "file";
      }

      if (directoriesByNormalizedPath.has(normalized)) {
        return "directory";
      }

      return "missing";
    },
  };
}

function createMemoryEntry(name: string, kind: "file" | "directory"): ProjectSourceEntry {
  return {
    name,
    isDirectory() {
      return kind === "directory";
    },
    isFile() {
      return kind === "file";
    },
  };
}

function normalizeToPosix(path: string): string {
  const withPosixSeparators = NodePath.sep === "/" ? path : path.replaceAll(NodePath.sep, "/");

  if (withPosixSeparators.length === 0) {
    return "/";
  }

  // Strip a Windows drive letter (`C:`) if present — the in-memory source
  // treats all paths as POSIX-rooted for determinism across platforms.
  const driveStripped = withPosixSeparators.replace(/^[A-Za-z]:/, "");
  const withLeadingSlash = driveStripped.startsWith("/") ? driveStripped : `/${driveStripped}`;

  return NodePath.posix.normalize(withLeadingSlash).replace(/\/+$/, "") || "/";
}

function splitPosixPath(normalizedPath: string): string[] {
  return normalizedPath.split("/").filter((segment) => segment.length > 0);
}
