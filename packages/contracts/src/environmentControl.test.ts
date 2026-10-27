import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CloudSessionFilesUpload,
  DiscoveredProvisionedEnvironment,
  EnvironmentProvisionResumeResult,
  MAX_SESSION_FILES_BYTES,
} from "./environmentControl.ts";

const decodeDiscovered = Schema.decodeUnknownSync(
  Schema.toCodecJson(DiscoveredProvisionedEnvironment),
);

const row = {
  requestId: "11111111-1111-4111-a111-000000000001",
  leaseId: "11111111-1111-4111-a111-000000000001",
  sandboxId: "sandbox-1",
  lifecycle: "paused",
  environmentId: "box-1",
  provider: "e2b",
  label: "t3code · E2B",
  repository: "pingdotgg/t3code",
  projectDir: "/home/user/work/t3code",
  threadId: "thread-1",
  createdAt: "2026-09-30T10:00:00.000Z",
  expiresAt: "2026-10-30T10:00:00.000Z",
};
const chat = (status: string) => ({
  sequence: 42,
  project: {
    id: "project-app",
    title: "t3code",
    workspaceRoot: "/home/user/work/t3code",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
  },
  thread: {
    createdBy: "user",
    creationSource: "server",
    id: "thread-1",
    projectId: "project-app",
    title: "Fix the login redirect",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    status,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: "2026-09-30T10:02:00.000Z",
    hasActionableProposedPlan: false,
    itemCount: 2,
    visibleItemCount: 2,
    createdAt: "2026-09-30T10:01:00.000Z",
    updatedAt: "2026-09-30T10:05:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  },
});

describe("DiscoveredProvisionedEnvironment", () => {
  it("keeps a box's chat it can read", () => {
    const decoded = decodeDiscovered({ ...row, chat: chat("idle") });
    expect([decoded.chat?.sequence, decoded.chat?.thread.title]).toEqual([
      42,
      "Fix the login redirect",
    ]);
  });

  it("drops a chat from a newer host it cannot read and keeps the rest of the box", () => {
    expect(decodeDiscovered({ ...row, chat: chat("pondering") })).toEqual(row);
  });
});

describe("EnvironmentProvisionResumeResult", () => {
  const decodeResume = Schema.decodeUnknownSync(
    Schema.toCodecJson(EnvironmentProvisionResumeResult),
  );
  const refused = {
    kind: "refused",
    reason: "unknown",
    message: "E2B couldn't start this machine yet. The problem is on E2B's side.",
  };

  it("keeps why a provider could not start the machine", () => {
    expect(decodeResume({ ...refused, cause: "provider-unavailable" })).toEqual({
      ...refused,
      cause: "provider-unavailable",
    });
  });

  it("reads a cause from a newer host as a plain refusal", () => {
    expect(decodeResume({ ...refused, cause: "provider-on-fire" })).toEqual(refused);
  });
});

describe("CloudSessionFilesUpload", () => {
  const accepts = Schema.is(CloudSessionFilesUpload);
  const upload = (path: string, contentsBase64 = "e30=") => ({
    device: "laptop",
    files: [{ path, contentsBase64 }],
  });

  it("takes paths inside the home, outside the machine's own T3 state", () => {
    expect(accepts(upload(".aws/sso/cache/token.json"))).toBe(true);
    for (const path of [
      "/etc/passwd",
      "../.ssh/id",
      ".aws/../../x",
      ".aws//config",
      ".t3/userdata/db",
    ])
      expect(accepts(upload(path)), path).toBe(false);
  });

  it("refuses a set larger than every waking machine should be sent", () => {
    const base64Length = Math.ceil(((MAX_SESSION_FILES_BYTES + 3) / 3) * 4);
    expect(accepts(upload(".npmrc", "A".repeat(base64Length)))).toBe(false);
  });
});
