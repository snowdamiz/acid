// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off - the host calls its boxes over private HTTP, Promise-side, as account switching does.
/**
 * The CLI logins a user's computer syncs to this host (`t3 sessions push`), kept in the home of
 * every awake cloud machine the host manages.
 *
 * @module environmentControl/sessionFileSync
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  type CloudSessionFiles,
  type CloudSessionFilesUpload,
  HomeFile,
  HomeRelativePath,
  WriteHomeFilesInput,
  WriteHomeFilesResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProvisionedLease, RemoteAccess } from "./ProvisionedLeaseRegistry.ts";

const StoredSessionFiles = Schema.Struct({
  device: Schema.NullOr(Schema.String),
  syncedAt: Schema.NullOr(Schema.String),
  files: Schema.Array(HomeFile),
});
type StoredSessionFiles = typeof StoredSessionFiles.Type;
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredSessionFiles));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredSessionFiles));

const SyncedPaths = Schema.Array(HomeRelativePath);
const decodeSyncedPaths = Schema.decodeUnknownSync(Schema.fromJsonString(SyncedPaths));
const encodeSyncedPaths = Schema.encodeSync(Schema.fromJsonString(SyncedPaths));

/** Boxes one pass writes to at once. */
const CONCURRENT_WRITES = 8;

const readIfPresent = (path: string) =>
  NodeFSP.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

/** Writes through a sibling and a rename, so a reader never sees half a file. */
async function writeAtomic(path: string, contents: string | Uint8Array, mode: number) {
  const partial = `${path}.t3-partial`;
  await NodeFSP.writeFile(partial, contents, { mode });
  // `writeFile` applies the umask, and leaves an existing partial's mode as it was.
  await NodeFSP.chmod(partial, mode);
  await NodeFSP.rename(partial, path);
}

const summarizeSessionFiles = (stored: StoredSessionFiles | null): CloudSessionFiles => ({
  device: stored?.device ?? null,
  syncedAt: stored?.syncedAt ?? null,
  files: (stored?.files ?? []).map((file) => ({
    path: file.path,
    bytes: Buffer.byteLength(file.contentsBase64, "base64"),
  })),
});

/**
 * Keeps the synced set in `path` and writes it to each awake box once per wake: a box that sleeps
 * is written again when it next wakes, since a box can come back on another machine. A pass after
 * an upload or a clear writes the new set to every awake box. A box that predates home-file writes
 * is not asked again until it next wakes, by which time it has been upgraded.
 */
export function makeSessionFileSync(options: {
  readonly path: string;
  readonly awake: () => Promise<ReadonlyArray<ProvisionedLease>>;
  readonly send: (
    remote: RemoteAccess,
    input: WriteHomeFilesInput,
  ) => Promise<WriteHomeFilesResult | "missing">;
  readonly onError: (lease: ProvisionedLease, cause: unknown) => void;
  readonly now?: () => Date;
}) {
  let current: Promise<{ value: StoredSessionFiles; version: string } | null> | undefined;
  const written = new Map<string, string>();
  let passing: Promise<void> | undefined;
  let again = false;

  const versioned = (value: StoredSessionFiles) => {
    const encoded = encodeStored(value);
    return { value, version: NodeCrypto.createHash("sha256").update(encoded).digest("hex") };
  };
  const load = () =>
    (current ??= readIfPresent(options.path).then(
      (text) => (text === null ? null : versioned(decodeStored(text))),
      (error: unknown) => {
        current = undefined;
        throw error;
      },
    ));
  const save = async (value: StoredSessionFiles) => {
    const next = versioned(value);
    await writeAtomic(options.path, encodeStored(value), 0o600);
    current = Promise.resolve(next);
    void sync().catch(() => undefined);
    return summarizeSessionFiles(value);
  };

  const pass = async () => {
    const stored = await load();
    // A host no computer ever synced to has nothing to keep, or to remove.
    if (stored === null) return;
    const leases = (await options.awake()).filter((lease) => lease.remoteAccess);
    const keyOf = (lease: ProvisionedLease) => `${lease.leaseId}\n${lease.remoteAccess!.origin}`;
    const awake = new Set(leases.map(keyOf));
    for (const key of written.keys()) if (!awake.has(key)) written.delete(key);
    const due = leases.filter((lease) => written.get(keyOf(lease)) !== stored.version);
    const write = async (lease: ProvisionedLease) => {
      try {
        await options.send(lease.remoteAccess!, { files: stored.value.files });
        written.set(keyOf(lease), stored.version);
      } catch (cause) {
        options.onError(lease, cause);
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENT_WRITES, due.length) }, async () => {
      for (let lease = due.shift(); lease; lease = due.shift()) await write(lease);
    });
    await Promise.all(workers);
  };

  /** One pass at a time; a request during one runs another after it. */
  const sync = (): Promise<void> => {
    if (passing) {
      again = true;
      return passing;
    }
    passing = (async () => {
      do {
        again = false;
        await pass();
      } while (again);
    })().finally(() => {
      passing = undefined;
    });
    return passing;
  };

  const now = () => (options.now ?? (() => new Date()))().toISOString();
  return {
    read: async () => summarizeSessionFiles((await load())?.value ?? null),
    upload: (input: CloudSessionFilesUpload) =>
      save({ device: input.device, syncedAt: now(), files: input.files }),
    /** Keeps an empty set rather than none, so the next pass removes the files from every box. */
    clear: () => save({ device: null, syncedAt: null, files: [] }),
    sync,
  };
}

const encodeWriteInput = Schema.encodeSync(Schema.fromJsonString(WriteHomeFilesInput));
const decodeWriteResult = Schema.decodeUnknownSync(WriteHomeFilesResult);

/** Hands a box its synced files over its published origin, with its broker token. */
export async function sendHomeFiles(
  remote: RemoteAccess,
  input: WriteHomeFilesInput,
): Promise<WriteHomeFilesResult | "missing"> {
  const response = await fetch(`${remote.origin}/api/environment-control/home-files`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${remote.brokerToken}`,
      "content-type": "application/json",
    },
    body: encodeWriteInput(input),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return "missing";
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The cloud machine answered the synced files with status ${response.status}.`);
  }
  return decodeWriteResult(await response.json());
}

/**
 * Replaces the synced files in this box's home with `files`, removing any an earlier set wrote and
 * this one leaves out. `manifest` records which paths the last set wrote.
 */
export async function writeSyncedHomeFiles(
  manifest: string,
  files: ReadonlyArray<HomeFile>,
  home = NodeOS.homedir(),
): Promise<WriteHomeFilesResult> {
  const text = await readIfPresent(manifest);
  const previous = text === null ? [] : decodeSyncedPaths(text);
  for (const file of files) {
    const target = NodePath.join(home, file.path);
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true, mode: 0o700 });
    await writeAtomic(target, Buffer.from(file.contentsBase64, "base64"), file.mode ?? 0o600);
  }
  const kept = new Set(files.map((file) => file.path));
  const stale = previous.filter((path) => !kept.has(path));
  for (const path of stale) await NodeFSP.rm(NodePath.join(home, path), { force: true });
  await NodeFSP.mkdir(NodePath.dirname(manifest), { recursive: true });
  await writeAtomic(manifest, encodeSyncedPaths([...kept]), 0o600);
  return { written: files.length, removed: stale.length };
}
