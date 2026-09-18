// @effect-diagnostics nodeBuiltinImport:off -- Eve source discovery is a standalone Node API, independent of Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { discoverAgent } from "./discover-agent.ts";
import { createMemoryProjectSource } from "./project-source.ts";

function source(files: Record<string, string>, directories: string[] = []) {
  return createMemoryProjectSource({
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [`/selected/${name}`, text]),
    ),
    directories: directories.map((name) => `/selected/${name}`),
  });
}

describe("Eve explicit-root discovery", () => {
  it("reads the selected folder without needing project metadata or importing its modules", async () => {
    const manifest = await discoverAgent({
      agentRoot: "/selected",
      source: createMemoryProjectSource({
        files: {
          "/selected/agent.ts": "throw new Error('discovery must not import modules');",
          "/selected/instructions.md": "Selected agent.",
          "/unrelated/instructions.md": "Other agent.",
        },
      }),
    });
    expect(manifest.agentRoot).toBe("/selected");
    expect(manifest.configModule).toEqual({ sourceKind: "module", logicalPath: "agent.ts" });
    expect(manifest.instructions).toEqual([
      {
        sourceKind: "markdown",
        logicalPath: "instructions.md",
        definition: { content: "Selected agent.", role: "system" },
      },
    ]);
  });

  it("orders flat and named instructions and ignores legacy instructions when modern ones exist", async () => {
    const manifest = await discoverAgent({
      agentRoot: "/selected",
      source: source({
        "instructions.md": "Flat.",
        "instructions/b.md": "Second.",
        "instructions/a.md": "First.",
        "system.md": "Legacy.",
      }),
    });
    expect(manifest.instructions.map((entry) => entry.logicalPath)).toEqual([
      "instructions.md",
      "instructions/a.md",
      "instructions/b.md",
    ]);
    expect(manifest.configModule).toBeUndefined();
  });

  it("falls back to the legacy system slot only when modern instructions are absent", async () => {
    const legacy = await discoverAgent({
      agentRoot: "/selected",
      source: source({ "system.md": "Legacy." }),
    });
    expect(legacy.instructions[0]?.logicalPath).toBe("system.md");
    const emptyModern = await discoverAgent({
      agentRoot: "/selected",
      source: source({ "system.md": "Legacy." }, ["instructions"]),
    });
    expect(emptyModern.instructions).toEqual([]);
  });

  it("describes executable sources and skill folders without imposing a harness policy", async () => {
    const manifest = await discoverAgent({
      agentRoot: "/selected",
      source: source(
        {
          "instructions.ts": "throw new Error('must not import');",
          "skills/review.md": "Review.",
          "skills/dynamic.ts": "throw new Error('must not import');",
          "tools/search.ts": "throw new Error('must not import');",
          "connections/service.ts": "throw new Error('must not import');",
          "subagents/child/instructions.md": "Child.",
        },
        ["skills/native"],
      ),
    });
    expect(manifest.instructions).toEqual([
      { sourceKind: "module", logicalPath: "instructions.ts" },
    ]);
    expect(manifest.skills).toEqual([
      { name: "dynamic", logicalPath: "skills/dynamic.ts", sourceKind: "module" },
      { name: "native", logicalPath: "skills/native", sourceKind: "directory" },
      { name: "review", logicalPath: "skills/review.md", sourceKind: "markdown" },
    ]);
    expect(manifest.capabilities).toEqual([
      { slot: "connections", logicalPath: "connections/service.ts" },
      { slot: "tools", logicalPath: "tools/search.ts" },
    ]);
  });

  for (const files of [
    { "instructions.md": "Markdown.", "instructions.ts": "export default {};" },
    { "instructions/a.md": "Markdown.", "instructions/a.mjs": "export default {};" },
    { "agent.ts": "export default {};", "agent.mjs": "export default {};" },
  ]) {
    it(`rejects colliding authored sources: ${Object.keys(files).join(", ")}`, async () => {
      await expect(
        discoverAgent({ agentRoot: "/selected", source: source(files) }),
      ).rejects.toThrow(/Conflicting|exactly one/);
    });
  }

  it("enforces disk boundaries and rejects symbolic links inside instruction directories", async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "eve-source-")),
    );
    try {
      const agentRoot = NodePath.join(root, "agent");
      await NodeFSP.mkdir(NodePath.join(agentRoot, "instructions"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, "outside.md"), "Outside.");
      await NodeFSP.symlink(
        NodePath.join(root, "outside.md"),
        NodePath.join(agentRoot, "instructions", "linked.md"),
      );
      await expect(discoverAgent({ agentRoot, boundaryRoot: agentRoot })).rejects.toThrow(
        /symbolic links/,
      );
      await expect(discoverAgent({ agentRoot: root, boundaryRoot: agentRoot })).rejects.toThrow(
        /must be inside/,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
