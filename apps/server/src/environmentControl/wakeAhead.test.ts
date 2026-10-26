import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  type CloudMachineKind,
  type DiscoveredProvisionedEnvironment,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";
import { makeWakeAhead, planWakeAhead } from "./wakeAhead.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const box = (
  name: string,
  input: {
    readonly lifecycle?: "active" | "paused";
    readonly machine?: CloudMachineKind;
    readonly thread?: Record<string, unknown> | null;
    readonly expiresAt?: string;
  } = {},
): DiscoveredProvisionedEnvironment => {
  const chat =
    input.thread === null
      ? null
      : ownerChat(
          boxShell([boxThread(`thread-${name}`, "project-app", name, input.thread)]),
          `thread-${name}`,
        );
  return {
    requestId: `request-${name}` as DiscoveredProvisionedEnvironment["requestId"],
    leaseId: `lease-${name}`,
    sandboxId: `sandbox-${name}`,
    lifecycle: input.lifecycle ?? "paused",
    environmentId: EnvironmentId.make(name),
    provider: input.machine === "mac" || input.machine === "devbox" ? "namespace" : "e2b",
    machine: input.machine ?? "sandbox",
    label: name,
    repository: null,
    threadId: ThreadId.make(`thread-${name}`),
    createdAt: "2026-09-30T10:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-10-01T13:00:00.000Z",
    ...(chat ? { chat } : {}),
  };
};

const names = (boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>) =>
  boxes.map((candidate) => candidate.environmentId);

const plan = (
  boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  state: {
    readonly present?: boolean;
    readonly inFlight?: ReadonlyArray<readonly [string, CloudMachineKind]>;
    readonly retryAt?: ReadonlyArray<readonly [string, number]>;
  } = {},
) => {
  const result = planWakeAhead(boxes, {
    now: NOW,
    present: state.present ?? true,
    inFlight: new Map(
      (state.inFlight ?? []).map(([name, machine]) => [EnvironmentId.make(name), machine]),
    ),
    retryAt: new Map(state.retryAt ?? []),
  });
  return { wake: names(result.wake), renew: names(result.renew) };
};

it("wakes every paused unsettled chat, most recently active first, and no settled one", () => {
  expect(
    plan([
      box("older", { thread: { updatedAt: "2026-10-01T09:00:00.000Z" } }),
      box("settled", {
        thread: { settledOverride: "settled", settledAt: "2026-10-01T10:00:00.000Z" },
      }),
      box("archived", { thread: { archivedAt: "2026-10-01T10:00:00.000Z" } }),
      box("snoozed", { thread: { snoozedUntil: "2026-10-01T15:00:00.000Z" } }),
      box("snooze-over", { thread: { snoozedUntil: "2026-10-01T11:00:00.000Z" } }),
      box("unread", { thread: null }),
      box("newer", { thread: { updatedAt: "2026-10-01T11:30:00.000Z" } }),
      box("awake", { lifecycle: "active" }),
    ]).wake,
  ).toEqual(["newer", "older", "snooze-over"]);
});

it("keeps at most twenty wakes in flight, counting ones already running", () => {
  const paused = Array.from({ length: 25 }, (_, index) =>
    box(`box-${String(index).padStart(2, "0")}`, {
      thread: { updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - index * 60_000)) },
    }),
  );
  expect(plan(paused).wake).toHaveLength(20);
  expect(plan(paused, { inFlight: [["opened-elsewhere", "sandbox"]] }).wake.at(-1)).toBe("box-18");
  expect(plan(paused, { inFlight: [["box-00", "sandbox"]] }).wake.slice(0, 2)).toEqual([
    "box-01",
    "box-02",
  ]);
});

it("leaves a box refused recently until its backoff passes", () => {
  const boxes = [box("refused"), box("fine")];
  expect(plan(boxes, { retryAt: [["lease-refused", NOW + 30_000]] }).wake).toEqual(["fine"]);
  expect(plan(boxes, { retryAt: [["lease-refused", NOW - 1]] }).wake).toEqual(["refused", "fine"]);
});

it("wakes one Mac at a time, and only while a Mac slot stays free after it", () => {
  const macs = [
    box("mac-a", { machine: "mac", thread: { updatedAt: "2026-10-01T11:00:00.000Z" } }),
    box("mac-b", { machine: "mac", thread: { updatedAt: "2026-10-01T10:00:00.000Z" } }),
  ];
  const awakeMac = (name: string) =>
    box(name, { machine: "mac", lifecycle: "active", thread: { settledOverride: "settled" } });
  expect(plan(macs).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1")]).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1"), awakeMac("live-2")]).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1"), awakeMac("live-2"), awakeMac("live-3")]).wake).toEqual(
    [],
  );
  expect(plan(macs, { inFlight: [["opened", "mac"]] }).wake).toEqual([]);
  expect(plan([...macs, box("sandbox")]).wake).toEqual(["mac-a", "sandbox"]);
});

it("renews awake unsettled chats whose lease ends within ten minutes", () => {
  expect(
    plan([
      box("ending", { lifecycle: "active", expiresAt: "2026-10-01T12:05:00.000Z" }),
      box("later", { lifecycle: "active", expiresAt: "2026-10-01T12:30:00.000Z" }),
      box("settled-ending", {
        lifecycle: "active",
        expiresAt: "2026-10-01T12:05:00.000Z",
        thread: { settledOverride: "settled" },
      }),
    ]).renew,
  ).toEqual(["ending"]);
});

/** A pull request the chat opened, with its watch as given; a link without one only shows it. */
const pullRequest = (
  input: {
    readonly watch?: "watching" | "ended";
    readonly state?: "open" | "merged";
    readonly source?: "created" | "stack-dismissed";
  } = {},
) => {
  const watch = {
    startedAt: "2026-10-01T11:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-10-01T11:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  };
  return {
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    source: input.source ?? "created",
    linkedAt: "2026-10-01T11:00:00.000Z",
    snapshot: input.state
      ? {
          state: input.state,
          title: "Fix the crash",
          headBranch: "fix/crash",
          baseBranch: "main",
          isDraft: false,
          updatedAt: null,
          syncedAt: "2026-10-01T11:00:00.000Z",
        }
      : null,
    stack: null,
    ...(input.watch === "watching" ? { watch } : {}),
    ...(input.watch === "ended" ? { endedWatch: watch } : {}),
  };
};

it("keeps chats watching a pull request awake with nobody here, and only those", () => {
  const watching = { pullRequests: [pullRequest({ watch: "watching", state: "open" })] };
  const boxes = [
    box("watching", { thread: watching }),
    box("watching-snoozed", { thread: { ...watching, snoozedUntil: "2026-10-01T15:00:00.000Z" } }),
    box("unsettled", { thread: { pullRequests: [pullRequest()] } }),
    box("watch-ended", { thread: { pullRequests: [pullRequest({ watch: "ended" })] } }),
    box("merged", {
      thread: { pullRequests: [pullRequest({ watch: "watching", state: "merged" })] },
    }),
    box("dismissed", {
      thread: { pullRequests: [pullRequest({ watch: "watching", source: "stack-dismissed" })] },
    }),
    box("settled", {
      thread: { ...watching, settledOverride: "settled", settledAt: "2026-10-01T11:30:00.000Z" },
    }),
    box("watching-ending", {
      lifecycle: "active",
      expiresAt: "2026-10-01T12:05:00.000Z",
      thread: watching,
    }),
    box("unsettled-ending", { lifecycle: "active", expiresAt: "2026-10-01T12:05:00.000Z" }),
  ];
  expect(plan(boxes, { present: false })).toEqual({
    wake: ["watching", "watching-snoozed"],
    renew: ["watching-ending"],
  });
  expect(plan(boxes).wake).toEqual([
    "watching",
    "watching-snoozed",
    "unsettled",
    "watch-ended",
    "merged",
    "dismissed",
  ]);
});

it.effect("wakes a chat watching its pull request though no client ever reports a user", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const resumed: Array<string> = [];
    const wakeAhead = makeWakeAhead({
      list: Effect.succeed([
        box("watching", { thread: { pullRequests: [pullRequest({ watch: "watching" })] } }),
        box("unsettled"),
      ]),
      resume: (target) =>
        Effect.sync(() => {
          resumed.push(target.environmentId);
          return { kind: "resumed" } as const;
        }),
      renew: () => Effect.void,
      scope: yield* Effect.scope,
    });
    yield* wakeAhead.pass;
    yield* Effect.yieldNow;
    expect(resumed).toEqual(["watching"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "wakes a present user's two unsettled chats, not the settled one, and reports each machine",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let boxes = [
        box("first"),
        box("second", { thread: { updatedAt: "2026-10-01T11:00:00.000Z" } }),
        box("settled", { thread: { settledOverride: "settled" } }),
      ];
      const resumed: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const wakeAhead = makeWakeAhead({
        list: Effect.sync(() => boxes),
        resume: (target) =>
          Effect.sync(() => resumed.push(target.environmentId)).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                boxes = boxes.map((candidate) =>
                  candidate.environmentId === target.environmentId
                    ? { ...candidate, lifecycle: "active" as const }
                    : candidate,
                );
                return { kind: "resumed" as const };
              }),
            ),
          ),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });

      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          { environmentId: "first", state: "asleep", machine: "sandbox", provider: "e2b" },
          { environmentId: "second", state: "asleep", machine: "sandbox", provider: "e2b" },
          { environmentId: "settled", state: "asleep", machine: "sandbox", provider: "e2b" },
        ],
      });
      expect(resumed).toEqual([]);
      expect(yield* wakeAhead.presence(true)).toEqual({
        machines: [
          { environmentId: "second", state: "waking", machine: "sandbox", provider: "e2b" },
          { environmentId: "first", state: "waking", machine: "sandbox", provider: "e2b" },
          { environmentId: "settled", state: "asleep", machine: "sandbox", provider: "e2b" },
        ],
      });
      expect(resumed).toEqual(["second", "first"]);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          { environmentId: "settled", state: "asleep", machine: "sandbox", provider: "e2b" },
        ],
      });
    }).pipe(Effect.scoped),
);
it.effect(
  "retries a refused wake after its backoff while the user stays, and stops once they leave",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const attempts: Array<number> = [];
      const wakeAhead = makeWakeAhead({
        list: Effect.succeed([box("crowded")]),
        resume: () =>
          Effect.sync(() => {
            attempts.push(attempts.length);
            return {
              kind: "refused",
              reason: "unknown",
              message: "E2B can't place this machine right now. Retrying.",
            } as const;
          }),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });
      const tick = wakeAhead.pass.pipe(Effect.andThen(Effect.yieldNow));
      yield* wakeAhead.presence(true);
      yield* Effect.yieldNow;
      expect(attempts).toHaveLength(1);
      yield* TestClock.adjust("20 seconds");
      yield* tick;
      expect(attempts).toHaveLength(1);
      yield* TestClock.adjust("15 seconds");
      yield* tick;
      expect(attempts).toHaveLength(2);
      yield* TestClock.adjust("10 minutes");
      yield* tick;
      expect(attempts).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect("tracks an upgrade as updating over a wake of the same machine", () =>
  Effect.gen(function* () {
    const wakeAhead = makeWakeAhead({
      list: Effect.succeed([]),
      resume: () => Effect.succeed({ kind: "resumed" }),
      renew: () => Effect.void,
      scope: yield* Effect.scope,
    });
    const upgrade = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(upgrade).pipe(
      wakeAhead.track(EnvironmentId.make("box"), "sandbox", "updating"),
      wakeAhead.track(EnvironmentId.make("box"), "sandbox", "waking"),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(yield* wakeAhead.presence(false)).toEqual({
      machines: [{ environmentId: "box", state: "updating", machine: "sandbox" }],
    });
    yield* Deferred.succeed(upgrade, undefined);
    yield* Fiber.join(fiber);
    expect(yield* wakeAhead.presence(false)).toEqual({ machines: [] });
  }).pipe(Effect.scoped),
);

it.effect(
  "says when a machine's provider last could not start it, until a wake answers otherwise",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const wakeAhead = makeWakeAhead({
        list: Effect.succeed([box("crowded")]),
        resume: () => Effect.succeed({ kind: "resumed" }),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });
      yield* wakeAhead.settle(EnvironmentId.make("crowded"), {
        kind: "refused",
        reason: "unknown",
        cause: "provider-unavailable",
        message: "E2B couldn't start this machine yet. The problem is on E2B's side.",
      });
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          {
            environmentId: "crowded",
            state: "asleep",
            machine: "sandbox",
            provider: "e2b",
            providerFailure: { cause: "provider-unavailable", at: "2026-10-01T12:00:00.000Z" },
          },
        ],
      });
      yield* wakeAhead.settle(EnvironmentId.make("crowded"), {
        kind: "refused",
        reason: "unknown",
        message: "The workspace could not be reconnected. Retry shortly.",
      });
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          { environmentId: "crowded", state: "asleep", machine: "sandbox", provider: "e2b" },
        ],
      });
    }).pipe(Effect.scoped),
);

const unplaced = {
  kind: "refused",
  reason: "unknown",
  cause: "provider-unavailable",
  message: "E2B couldn't start this machine yet. The problem is on E2B's side.",
} as const;

it.effect("stops saying a provider is failing once the host would not retry the machine", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const wakeAhead = makeWakeAhead({
      list: Effect.succeed([
        box("crowded"),
        box("settled", { thread: { settledOverride: "settled" } }),
      ]),
      resume: () => Effect.succeed(unplaced),
      renew: () => Effect.void,
      scope: yield* Effect.scope,
    });
    yield* wakeAhead.settle(EnvironmentId.make("crowded"), unplaced);
    yield* wakeAhead.settle(EnvironmentId.make("settled"), unplaced);
    expect(yield* wakeAhead.presence(false)).toEqual({
      machines: [
        {
          environmentId: "crowded",
          state: "asleep",
          machine: "sandbox",
          provider: "e2b",
          providerFailure: { cause: "provider-unavailable", at: "2026-10-01T12:00:00.000Z" },
        },
        { environmentId: "settled", state: "asleep", machine: "sandbox", provider: "e2b" },
      ],
    });
    yield* TestClock.adjust("11 minutes");
    expect(yield* wakeAhead.presence(false)).toEqual({
      machines: [
        { environmentId: "crowded", state: "asleep", machine: "sandbox", provider: "e2b" },
        { environmentId: "settled", state: "asleep", machine: "sandbox", provider: "e2b" },
      ],
    });
  }).pipe(Effect.scoped),
);
