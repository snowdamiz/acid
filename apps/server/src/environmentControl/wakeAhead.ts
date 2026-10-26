import type {
  EnvironmentControlError,
  CloudMachineKind,
  CloudMachineState,
  DiscoveredProvisionedEnvironment,
  EnvironmentControlPresenceResult,
  EnvironmentId,
  EnvironmentProvisionResumeResult,
  ProviderStartFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

type MachineWake = Exclude<CloudMachineState, "asleep">;

/** Wakes in flight at once, a client's included. Past it a pass leaves the rest for the next. */
const MAX_CONCURRENT_WAKES = 20;
/**
 * Macs the Namespace account runs at once (24 vCPU of 6 vCPU Macs), shared with chats the user
 * opens and template builds. A wake ahead never takes the last one.
 */
const MAC_SLOTS = 4;
/** An awake chat kept awake is renewed once its lease ends within this. */
const RENEW_WITHIN_MS = 10 * 60_000;
/** How long one report of a present user lasts. Clients report every 4 minutes. */
const PRESENCE_TTL_MS = 6 * 60_000;
/** After each refused wake in a row; the last step repeats. Matches the client's wake backoff. */
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000];
/** A provider failure older than the longest backoff is not one a retry is still answering. */
const PROVIDER_FAILURE_FRESH_MS = BACKOFF_MS.at(-1)!;

/** When the chat a box holds last changed, or null when it is not one to keep awake. */
const unsettledSince = (box: DiscoveredProvisionedEnvironment, now: number): number | null => {
  const thread = box.chat?.thread;
  if (!thread || thread.archivedAt !== null || thread.settledOverride === "settled") return null;
  if (thread.snoozedUntil && DateTime.toEpochMillis(thread.snoozedUntil) > now) return null;
  return DateTime.toEpochMillis(thread.updatedAt);
};

/**
 * Whether a box's chat watches one of its pull requests. The watch polls from the box's own server,
 * so it sees CI and review comments only while the box is awake. It ends on its own once the pull
 * request merges or closes or the chat settles, snoozed or not.
 */
const watchesPullRequest = (box: DiscoveredProvisionedEnvironment): boolean => {
  const thread = box.chat?.thread;
  if (
    !thread ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null
  )
    return false;
  return (thread.pullRequests ?? []).some(
    (link) =>
      link.watch !== undefined &&
      link.source !== "stack-dismissed" &&
      link.snapshot?.state !== "merged",
  );
};

/** When the chat a box holds last changed, or null when it watches no pull request. */
const watchingSince = (box: DiscoveredProvisionedEnvironment): number | null =>
  watchesPullRequest(box) ? DateTime.toEpochMillis(box.chat!.thread.updatedAt) : null;

/**
 * Which boxes to wake and which to renew. While the user is here, every paused box holding an
 * unsettled chat wakes; whether or not they are, so does every one whose chat watches a pull
 * request. The most recently active wake first, up to the ceiling of wakes in flight, except one
 * refused recently. A Mac wakes one at a time, and only while a slot stays free after it. Awake
 * boxes kept awake whose lease is about to end are renewed.
 */
export function planWakeAhead(
  boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  state: {
    readonly now: number;
    readonly present: boolean;
    readonly inFlight: ReadonlyMap<EnvironmentId, CloudMachineKind>;
    readonly retryAt: ReadonlyMap<string, number>;
  },
): {
  readonly wake: ReadonlyArray<DiscoveredProvisionedEnvironment>;
  readonly renew: ReadonlyArray<DiscoveredProvisionedEnvironment>;
} {
  const { now, present, inFlight, retryAt } = state;
  const unsettled = boxes
    .map((box) => ({
      box,
      since: (present ? unsettledSince(box, now) : null) ?? watchingSince(box),
    }))
    .filter(
      (entry): entry is { box: DiscoveredProvisionedEnvironment; since: number } =>
        entry.since !== null && !inFlight.has(entry.box.environmentId),
    )
    .toSorted((left, right) => right.since - left.since)
    .map(({ box }) => box);
  const macsWaking = [...inFlight.values()].filter((machine) => machine === "mac").length;
  let macsInUse =
    macsWaking + boxes.filter((box) => box.machine === "mac" && box.lifecycle === "active").length;
  let room = MAX_CONCURRENT_WAKES - inFlight.size;
  const wake: Array<DiscoveredProvisionedEnvironment> = [];
  for (const box of unsettled) {
    if (room <= 0) break;
    if (box.lifecycle !== "paused" || (retryAt.get(box.leaseId) ?? 0) > now) continue;
    if (box.machine === "mac") {
      if (macsWaking > 0 || macsInUse + 1 >= MAC_SLOTS || wake.some((it) => it.machine === "mac"))
        continue;
      macsInUse++;
    }
    wake.push(box);
    room--;
  }
  const renew = unsettled.filter(
    (box) => box.lifecycle === "active" && Date.parse(box.expiresAt) - now < RENEW_WITHIN_MS,
  );
  return { wake, renew };
}

/**
 * Wakes a present user's unsettled cloud chats ahead of them and keeps them awake, keeps chats
 * watching a pull request awake whoever is here, and knows which machines are waking or updating
 * right now, whoever asked. Presence lapses on its own a few minutes after the last client reports
 * it, and the reaper then puts the boxes no longer kept awake to sleep.
 */
export function makeWakeAhead(deps: {
  /** Every box the host holds, each with the chat it last read from it. */
  readonly list: Effect.Effect<
    ReadonlyArray<DiscoveredProvisionedEnvironment>,
    EnvironmentControlError
  >;
  readonly resume: (
    box: DiscoveredProvisionedEnvironment,
  ) => Effect.Effect<EnvironmentProvisionResumeResult>;
  readonly renew: (
    box: DiscoveredProvisionedEnvironment,
  ) => Effect.Effect<unknown, EnvironmentControlError>;
  readonly scope: Scope.Scope;
}) {
  let presentUntil = 0;
  let passing = false;
  /** Each wake or upgrade in flight per machine; one box can have a client's and a host's. */
  const tracked = new Map<
    EnvironmentId,
    Map<symbol, { readonly machine: CloudMachineKind; readonly wake: MachineWake }>
  >();
  const failures = new Map<string, { readonly count: number; readonly retryAt: number }>();
  /** Why and when each machine's provider last could not start it, whoever asked for the wake. */
  const providerFailures = new Map<
    EnvironmentId,
    { readonly cause: ProviderStartFailure; readonly at: number }
  >();
  /** A machine's provider failure, said only while a retry is in flight or still due. */
  const providerFailure = (environmentId: EnvironmentId, retrying: boolean, now: number) => {
    const failure = providerFailures.get(environmentId);
    return failure === undefined || !retrying || now - failure.at > PROVIDER_FAILURE_FRESH_MS
      ? {}
      : {
          providerFailure: {
            cause: failure.cause,
            at: DateTime.formatIso(DateTime.makeUnsafe(failure.at)),
          },
        };
  };

  const track =
    (environmentId: EnvironmentId, machine: CloudMachineKind, wake: MachineWake) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const token = Symbol(wake);
          const entries = tracked.get(environmentId) ?? new Map();
          entries.set(token, { machine, wake });
          tracked.set(environmentId, entries);
          return token;
        }),
        () => effect,
        (token) =>
          Effect.sync(() => {
            const entries = tracked.get(environmentId);
            entries?.delete(token);
            if (entries?.size === 0) tracked.delete(environmentId);
          }),
      );

  /** Every machine not awake: those with a wake or upgrade in flight, then the paused ones. */
  const machines = (
    boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>,
    now: number,
  ): EnvironmentControlPresenceResult["machines"] => {
    const providers = new Map(boxes.map((box) => [box.environmentId, box.provider]));
    const provider = (environmentId: EnvironmentId) => {
      const known = providers.get(environmentId);
      return known === undefined ? {} : { provider: known };
    };
    return [
      ...[...tracked].map(([environmentId, entries]) => {
        const wakes = [...entries.values()];
        return {
          environmentId,
          state: wakes.some((entry) => entry.wake === "updating")
            ? ("updating" as const)
            : ("waking" as const),
          machine: wakes[0]!.machine,
          ...provider(environmentId),
          ...providerFailure(environmentId, true, now),
        };
      }),
      ...boxes
        .filter((box) => box.lifecycle === "paused" && !tracked.has(box.environmentId))
        .map((box) => ({
          environmentId: box.environmentId,
          state: "asleep" as const,
          machine: box.machine ?? "sandbox",
          provider: box.provider,
          ...providerFailure(
            box.environmentId,
            unsettledSince(box, now) !== null || watchesPullRequest(box),
            now,
          ),
        })),
    ];
  };

  const wakeBox = Effect.fn("wakeAhead.wake")(function* (box: DiscoveredProvisionedEnvironment) {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* deps.resume(box);
    const now = yield* Clock.currentTimeMillis;
    if (result.kind === "resumed" || result.reason !== "unknown") failures.delete(box.leaseId);
    else {
      const count = (failures.get(box.leaseId)?.count ?? 0) + 1;
      failures.set(box.leaseId, {
        count,
        retryAt: now + BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1]!,
      });
    }
    yield* Effect.logInfo("cloud chat woken ahead", {
      leaseId: box.leaseId,
      machine: box.machine,
      result: result.kind === "resumed" ? "resumed" : `refused: ${result.reason}`,
      durationMs: now - startedAt,
    });
  });

  /** One pass over the host's boxes; a pass already running is joined. */
  const pass = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (passing) return;
    passing = true;
    const present = now < presentUntil;
    yield* Effect.gen(function* () {
      const boxes = yield* deps.list;
      const inFlight = new Map(
        [...tracked].map(([environmentId, entries]) => [
          environmentId,
          [...entries.values()][0]!.machine,
        ]),
      );
      const retryAt = new Map(
        [...failures].map(([leaseId, failure]) => [leaseId, failure.retryAt]),
      );
      const plan = planWakeAhead(boxes, { now, present, inFlight, retryAt });
      for (const box of plan.wake)
        // Started at once so the wake counts as in flight before this pass ends.
        yield* track(
          box.environmentId,
          box.machine ?? "sandbox",
          "waking",
        )(wakeBox(box)).pipe(Effect.forkIn(deps.scope, { startImmediately: true }));
      for (const box of plan.renew)
        yield* deps.renew(box).pipe(Effect.ignore, Effect.forkIn(deps.scope));
      if (plan.wake.length > 0 || plan.renew.length > 0)
        yield* Effect.logInfo("cloud chats kept awake", {
          present,
          watchingPullRequests: [...plan.wake, ...plan.renew].filter(watchesPullRequest).length,
          waking: plan.wake.length,
          renewed: plan.renew.length,
          inFlight: inFlight.size,
          backingOff: [...retryAt.values()].filter((at) => at > now).length,
        });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("cloud chats could not be woken", { cause })),
      Effect.ensuring(Effect.sync(() => (passing = false))),
    );
  });

  return {
    track,
    pass,
    /** Records how a resume of a machine answered, so presence can say its provider is failing. */
    settle: (environmentId: EnvironmentId, result: EnvironmentProvisionResumeResult) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (result.kind === "refused" && result.cause !== undefined)
          providerFailures.set(environmentId, { cause: result.cause, at: now });
        else providerFailures.delete(environmentId);
      }),
    /**
     * A client's report. A present user is counted for a few minutes and their chats start
     * waking before the answer; an absent one only reads it, since another client may be here.
     */
    presence: Effect.fn("wakeAhead.presence")(function* (present: boolean) {
      if (present) {
        presentUntil = (yield* Clock.currentTimeMillis) + PRESENCE_TTL_MS;
        yield* pass;
      }
      const boxes = yield* deps.list.pipe(Effect.orElseSucceed(() => []));
      const now = yield* Clock.currentTimeMillis;
      return { machines: machines(boxes, now) } satisfies EnvironmentControlPresenceResult;
    }),
  };
}
