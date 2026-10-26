import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentProvisionInput,
  type Project,
  type ProvisionProvider,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { EnvironmentControl } from "../../../environmentControl/EnvironmentControl.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../../../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CloudHandlers from "./handlers.ts";
import { CloudToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:cloud");
const threadId = ThreadId.make("thread:cloud");

const harness = (input: {
  readonly offered: ReadonlyArray<ProvisionProvider>;
  readonly identity: Partial<RepositoryIdentity> | null;
  readonly requests: Ref.Ref<ReadonlyArray<EnvironmentProvisionInput>>;
}) =>
  McpToolAccess.HandlersLayer.layer(CloudHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:cloud",
          thread: {
            threadId,
            providerSessionId: "provider:cloud",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/work/app" } as Project)),
        }),
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(input.identity as RepositoryIdentity | null),
        }),
        Layer.mock(EnvironmentControl)({
          provisionProviders: Effect.succeed(input.offered),
          // A machine that never gets ready within the launch's budget.
          provision: (request) =>
            Ref.update(input.requests, (all) => [...all, request]).pipe(
              Effect.andThen(Effect.never),
            ),
        }),
      ),
    ),
  );

const launch = (params: Record<string, unknown>) =>
  CloudToolkit.pipe(
    Effect.flatMap((toolkit) =>
      toolkit.handle("t3_cloud_chat_launch", {
        title: "Run the simulator",
        message: "Boot the iOS simulator and run the app.",
        ...params,
      } as never),
    ),
    Stream.unwrap,
    Stream.runCollect,
  );

it.effect(
  "starts the chat on the chosen machine with the project's repository and the caller's model, answering that it is still starting",
  () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<EnvironmentProvisionInput>>([]);
      yield* Effect.gen(function* () {
        const call = yield* launch({ provider: "namespace", branch: "main" }).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("50 seconds");
        const result = (yield* Fiber.join(call)).at(-1)?.result;
        const [request] = yield* Ref.get(requests);
        expect(request).toMatchObject({
          provider: "namespace",
          providerInstanceId: "codex",
          repository: "snowdamiz/sigentic",
          branch: "main",
          chat: {
            firstTurn: {
              text: "Boot the iOS simulator and run the app.",
              title: "Run the simulator",
              modelSelection: { instanceId: "codex", model: "gpt-5" },
              runtimeMode: "full-access",
            },
          },
        });
        expect(result).toEqual({
          threadId: request?.chat?.threadId,
          provider: "namespace",
          repository: "snowdamiz/sigentic",
          status: "starting",
        });
      }).pipe(
        Effect.provide(
          harness({
            offered: ["e2b", "namespace"],
            identity: { owner: "snowdamiz", name: "sigentic" },
            requests,
          }),
        ),
      );
    }),
);

it.effect(
  "refuses a machine kind the host does not offer, or a project with no GitHub repository, and provisions nothing",
  () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<EnvironmentProvisionInput>>([]);
      const notOffered = yield* launch({ provider: "namespace" }).pipe(
        Effect.provide(
          harness({
            offered: ["e2b"],
            identity: { owner: "snowdamiz", name: "sigentic" },
            requests,
          }),
        ),
      );
      const noRepository = yield* launch({ provider: "e2b" }).pipe(
        Effect.provide(harness({ offered: ["e2b"], identity: null, requests })),
      );
      expect(notOffered.at(-1)?.result).toMatchObject({
        code: "invalid_request",
        message: "This host cannot start namespace machines. It offers: e2b.",
      });
      expect(noRepository.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(requests)).toEqual([]);
    }),
);
