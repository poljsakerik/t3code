import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { searchAgentSkills } from "./AgentSkills.ts";

it.effect("searches the public catalog and ignores entries that cannot be installed", () =>
  Effect.gen(function* () {
    const result = yield* searchAgentSkills({ query: "impeccable & design" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe("https://skills.sh");
        expect(url.searchParams.get("q")).toBe("impeccable & design");
        expect(url.searchParams.get("limit")).toBe("20");
        return Response.json({
          skills: [
            { name: "impeccable", source: "pbakaus/impeccable", installs: 200 },
            { name: "../escape", source: "owner/repo", installs: 1 },
            { name: "unknown", source: "https://example.com", installs: 1 },
          ],
        });
      }),
    );
    expect(result.skills).toEqual([
      { name: "impeccable", source: "pbakaus/impeccable", installs: 200 },
    ]);
  }),
);

for (const status of [429, 503]) {
  it.effect(`reports a catalog HTTP ${status} instead of an empty search`, () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        searchAgentSkills({ query: "impeccable" }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(
            FetchHttpClient.Fetch,
            async () => new Response("Unavailable", { status }),
          ),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("GitHub repository");
    }),
  );
}
