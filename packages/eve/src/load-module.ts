// @effect-diagnostics nodeBuiltinImport:off -- Eve source discovery is a standalone Node API, independent of Effect.
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { createDiskProjectSource } from "./project-source.ts";
import type { AgentSourceManifest } from "./discover-agent.ts";

const requireAgent = NodeModule.createRequire(import.meta.url);

/** Loads only the selected configuration export, independently of any model runtime. */
export async function loadAgentConfiguration(manifest: AgentSourceManifest): Promise<unknown> {
  if (manifest.configModule === undefined) throw new Error("Agent has no configuration module.");
  const configPath = NodePath.join(manifest.agentRoot, manifest.configModule.logicalPath);
  const source = await createDiskProjectSource({ boundaryRoot: manifest.agentRoot }).readTextFile(
    configPath,
  );

  // CommonJS ignores URL queries and maintains a separate cache from ESM.
  delete requireAgent.cache[configPath];
  const moduleUrl = `${NodeURL.pathToFileURL(configPath).href}?eve=${NodeCrypto.createHash("sha256").update(source).digest("hex")}`;
  // Node 22.16 (our minimum) has the stripping API but does not enable it by
  // default. Scope the hook to this source so desktop and CLI load it alike.
  const hooks = NodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url !== moduleUrl || !/\.(?:cts|mts|ts)$/.test(configPath)) return nextLoad(url, context);
      return {
        format: configPath.endsWith(".cts") ? "commonjs" : "module",
        source: NodeModule.stripTypeScriptTypes(source),
        shortCircuit: true,
      };
    },
  });
  try {
    return ((await import(/* @vite-ignore */ moduleUrl)) as { default?: unknown }).default;
  } finally {
    hooks.deregister();
  }
}
