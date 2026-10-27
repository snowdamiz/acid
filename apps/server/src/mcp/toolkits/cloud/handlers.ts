import {
  cloneRepository,
  MessageId,
  OrchestratorMcpFailure,
  ProvisionRequestId,
  ThreadId,
  type EnvironmentProvisionInput,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProvisionProvider,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { EnvironmentControl } from "../../../environmentControl/EnvironmentControl.ts";
import * as Project from "../../../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../../../project/RepositoryIdentityResolver.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { loadCaller, resolveProjectId, unavailable } from "../../threadAccess.ts";
import { CloudToolkit } from "./tools.ts";

/**
 * How long a launch waits for its machine before answering that it is still starting. The
 * host's scope owns the provisioning drive, so the machine keeps getting ready after this.
 */
const LAUNCH_BUDGET = Duration.seconds(50);

/**
 * The provision request for a chat a thread on this host starts on a cloud machine. The account
 * is left to routing, which runs the chat on the model's driver account with the most usage
 * left. The host starts the first turn itself, with or without a client connected.
 */
function cloudChatInput(input: {
  readonly ids: { readonly request: string; readonly thread: string; readonly message: string };
  readonly provider: ProvisionProvider;
  readonly repository: string;
  readonly branch: string | undefined;
  readonly title: string;
  readonly message: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly createdAt: string;
}): EnvironmentProvisionInput {
  return {
    requestId: ProvisionRequestId.make(input.ids.request),
    provider: input.provider,
    providerInstanceId: input.modelSelection.instanceId,
    repository: input.repository,
    ...(input.branch === undefined ? {} : { branch: input.branch }),
    chat: {
      threadId: ThreadId.make(input.ids.thread),
      firstTurn: {
        messageId: MessageId.make(input.ids.message),
        text: input.message,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        createdAt: input.createdAt,
      },
    },
  };
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const layer = McpToolAccess.toLayer(CloudToolkit, {
  t3_cloud_chat_launch: McpToolAccess.startsThreads(
    (input) => input,
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (!scope.capabilities.has("orchestration") && !scope.capabilities.has("cloud-launch"))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This credential cannot start cloud chats.",
          });
        const context = yield* loadCaller();
        const control = yield* EnvironmentControl;
        const offered = yield* control.provisionProviders.pipe(
          Effect.orElseSucceed((): ReadonlyArray<ProvisionProvider> => []),
        );
        if (!offered.includes(input.provider))
          return yield* invalid(
            offered.length === 0
              ? "This host cannot start cloud machines; its provisioning is not configured."
              : `This host cannot start ${input.provider} machines. It offers: ${offered.join(", ")}.`,
          );
        const projectId = yield* resolveProjectId(context, input.projectId);
        const project = yield* Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
        );
        if (Option.isNone(project)) return yield* invalid("The project was not found.");
        // Resolved here rather than read off the project, whose identity stays empty until a
        // background lookup lands.
        const repository = cloneRepository(
          yield* RepositoryIdentityResolver.pipe(
            Effect.flatMap((repositories) => repositories.resolve(project.value.workspaceRoot)),
          ),
        );
        if (repository === undefined)
          return yield* invalid(
            "The project has no GitHub repository, so a cloud machine has nothing to clone.",
          );
        const modelSelection = input.modelSelection ?? context.caller?.modelSelection;
        if (modelSelection === undefined)
          return yield* invalid(
            "Pass modelSelection: this MCP client is not running inside a T3 thread.",
          );
        const crypto = yield* Crypto.Crypto;
        const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
        const ids = { request: yield* uuid, thread: yield* uuid, message: yield* uuid };
        const request = cloudChatInput({
          ids,
          provider: input.provider,
          repository,
          branch: input.branch,
          title: input.title,
          message: input.message,
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        const launched = {
          threadId: ThreadId.make(ids.thread),
          provider: input.provider,
          repository,
        };
        const outcome = yield* control.provision(request).pipe(
          Effect.timeoutOption(LAUNCH_BUDGET),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
        if (Option.isNone(outcome)) return { ...launched, status: "starting" as const };
        const result = outcome.value;
        if (result.kind === "refused")
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: result.message,
          });
        return result.kind === "ready"
          ? {
              ...launched,
              status: "ready" as const,
              environmentId: result.environment.environmentId,
            }
          : { ...launched, status: "starting" as const };
      }),
  ),
});
