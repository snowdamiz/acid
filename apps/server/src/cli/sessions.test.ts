import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { collectHomeFiles } from "./sessions.ts";

it.effect("collects each synced file and everything under a synced folder, with its mode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sessions-" });
    yield* fs.makeDirectory(path.join(home, ".aws", "sso", "cache", "nested"), { recursive: true });
    yield* fs.writeFileString(path.join(home, ".aws", "config"), "[default]");
    yield* fs.chmod(path.join(home, ".aws", "config"), 0o644);
    yield* fs.writeFileString(path.join(home, ".aws", "sso", "cache", "a.json"), "{}");
    yield* fs.chmod(path.join(home, ".aws", "sso", "cache", "a.json"), 0o600);
    yield* fs.writeFileString(path.join(home, ".aws", "sso", "cache", "nested", "b.json"), "[]");
    yield* fs.chmod(path.join(home, ".aws", "sso", "cache", "nested", "b.json"), 0o600);

    const files = yield* collectHomeFiles(home, [".aws/config", ".aws/sso/cache", ".kube/config"]);
    assert.deepEqual(
      files.toSorted((left, right) => left.path.localeCompare(right.path)),
      [
        {
          path: ".aws/config",
          contentsBase64: Buffer.from("[default]").toString("base64"),
          mode: 0o644,
        },
        {
          path: ".aws/sso/cache/a.json",
          contentsBase64: Buffer.from("{}").toString("base64"),
          mode: 0o600,
        },
        {
          path: ".aws/sso/cache/nested/b.json",
          contentsBase64: Buffer.from("[]").toString("base64"),
          mode: 0o600,
        },
      ],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
