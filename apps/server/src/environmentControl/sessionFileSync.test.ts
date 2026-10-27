// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests write a real home and store in a temporary directory, through the module's Promise-side clock.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { WriteHomeFilesInput } from "@t3tools/contracts";
import { afterEach, assert, beforeEach, it } from "@effect/vitest";

import type { ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";
import { makeSessionFileSync, writeSyncedHomeFiles } from "./sessionFileSync.ts";

let directory: string;
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "session-file-sync-"));
});
afterEach(() => NodeFSP.rm(directory, { recursive: true, force: true }));

const base64 = (text: string) => Buffer.from(text).toString("base64");

it("writes a set into the home and removes what an earlier set wrote and this one leaves out", async () => {
  const home = NodePath.join(directory, "home");
  const manifest = NodePath.join(directory, "state", "synced-home-files.json");
  await NodeFSP.mkdir(NodePath.join(home, ".aws"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(home, ".aws", "notes"), "the agent's own");

  assert.deepEqual(
    await writeSyncedHomeFiles(
      manifest,
      [
        { path: ".aws/sso/cache/token.json", contentsBase64: base64("token") },
        { path: ".kube/config", contentsBase64: base64("kube"), mode: 0o640 },
      ],
      home,
    ),
    { written: 2, removed: 0 },
  );
  const token = NodePath.join(home, ".aws", "sso", "cache", "token.json");
  assert.equal(await NodeFSP.readFile(token, "utf8"), "token");
  assert.equal((await NodeFSP.stat(token)).mode & 0o777, 0o600);
  assert.equal((await NodeFSP.stat(NodePath.join(home, ".kube", "config"))).mode & 0o777, 0o640);

  assert.deepEqual(
    await writeSyncedHomeFiles(
      manifest,
      [{ path: ".aws/sso/cache/token.json", contentsBase64: base64("renewed") }],
      home,
    ),
    { written: 1, removed: 1 },
  );
  assert.equal(await NodeFSP.readFile(token, "utf8"), "renewed");
  const exists = (path: string) =>
    NodeFSP.stat(path).then(
      () => true,
      () => false,
    );
  assert.isFalse(await exists(NodePath.join(home, ".kube", "config")));
  assert.equal(
    await NodeFSP.readFile(NodePath.join(home, ".aws", "notes"), "utf8"),
    "the agent's own",
  );
});

const lease = (leaseId: string, origin = `https://${leaseId}.example`) =>
  ({ leaseId, remoteAccess: { origin, brokerToken: "broker" } }) as ProvisionedLease;

const harness = (awake: Array<ProvisionedLease>) => {
  const sent: Array<{ origin: string; input: WriteHomeFilesInput }> = [];
  const failing = new Set<string>();
  const failures: Array<string> = [];
  const make = () =>
    makeSessionFileSync({
      path: NodePath.join(directory, "cloud-session-files.bin"),
      awake: async () => awake,
      send: async (remote, input) => {
        if (failing.has(remote.origin)) throw new Error("unreachable");
        sent.push({ origin: remote.origin, input });
        return { written: input.files.length, removed: 0 };
      },
      onError: (failed) => failures.push(failed.leaseId),
      now: () => new Date("2026-10-26T12:00:00.000Z"),
    });
  return { sent, failing, failures, make };
};

it("keeps nothing on cloud machines until a computer syncs", async () => {
  const { sent, make } = harness([lease("a")]);
  const sync = make();
  await sync.sync();
  assert.deepEqual(sent, []);
  assert.deepEqual(await sync.read(), { device: null, syncedAt: null, files: [] });
});

it("writes a synced set to each awake machine once per wake, and again after it changes", async () => {
  const awake = [lease("a"), lease("b")];
  const { sent, failing, failures, make } = harness(awake);
  const sync = make();
  const files = [{ path: ".aws/config", contentsBase64: base64("[default]") }];

  failing.add("https://b.example");
  assert.deepEqual(await sync.upload({ device: "laptop", files }), {
    device: "laptop",
    syncedAt: "2026-10-26T12:00:00.000Z",
    files: [{ path: ".aws/config", bytes: 9 }],
  });
  await sync.sync();
  assert.deepEqual(
    sent.map((write) => write.origin),
    ["https://a.example"],
  );
  assert.deepEqual(sent[0]!.input, { files });
  assert.include(failures, "b");

  failing.clear();
  await sync.sync();
  await sync.sync();
  assert.deepEqual(
    sent.map((write) => write.origin),
    ["https://a.example", "https://b.example"],
  );

  // `a` sleeps, then wakes on another machine.
  awake.splice(0, 1);
  await sync.sync();
  awake.push(lease("a", "https://a-moved.example"));
  await sync.sync();
  assert.equal(sent.at(-1)!.origin, "https://a-moved.example");
  assert.equal(sent.length, 3);

  // A host restarted on the same store keeps the set, and writes it once to each awake machine.
  const restarted = make();
  assert.deepEqual((await restarted.read()).files, [{ path: ".aws/config", bytes: 9 }]);
  await restarted.sync();
  assert.equal(sent.length, 5);

  await restarted.clear();
  await restarted.sync();
  assert.deepEqual(
    sent.slice(5).map((write) => write.input),
    [{ files: [] }, { files: [] }],
  );
  assert.deepEqual(await restarted.read(), { device: null, syncedAt: null, files: [] });
});
