import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

export const LOCAL_AGENT_RUNS_DISABLED_MESSAGE =
  "This server does not run agents. Start the chat on a cloud environment.";

/**
 * A cloud-only host's only runs are its automations, which read untrusted webhook text beside the
 * host's credentials. They run on Claude, the one driver that can run them with no built-in tool.
 */
export const AUTOMATION_HOST_DRIVER_MESSAGE =
  "Automations on this server run on Claude only, with no built-in tools. Pick a Claude model for the task.";

/** False on a cloud-only host (T3CODE_LOCAL_AGENT_RUNS=false). */
export const localAgentRunsEnabled = Effect.serviceOption(ServerConfig.ServerConfig).pipe(
  Effect.map(Option.match({ onNone: () => true, onSome: (config) => config.localAgentRuns })),
);

/**
 * Whether scheduled and webhook tasks may run their agent here: on any host that runs agents, and
 * on a cloud-only host that allows automations (T3CODE_LOCAL_AUTOMATION_RUNS=true).
 */
export const localAutomationRunsEnabled = Effect.serviceOption(ServerConfig.ServerConfig).pipe(
  Effect.map(
    Option.match({
      onNone: () => true,
      onSome: (config) => config.localAgentRuns || config.localAutomationRuns === true,
    }),
  ),
);

/**
 * A cloud-only host must never start a run here. Clients, scheduled tasks,
 * limit recovery and MCP tools all reach the orchestrator through
 * ThreadManagementService, so it refuses turns and answers with this.
 * ThreadLaunchService checks too, before it creates the thread.
 */
export const makeLocalRunRefusal = Effect.map(
  Effect.all([localAgentRunsEnabled, localAutomationRunsEnabled]),
  ([localAgentRuns, localAutomationRuns]) =>
    (command: {
      readonly type: string;
      readonly commandId: OrchestrationV2ServerCommand["commandId"];
      readonly scheduledTaskId?: unknown;
    }) =>
      !localAgentRuns &&
      (command.type === "message.dispatch" || command.type === "runtime-request.respond") &&
      // A task's own prompt may run where automations do; nothing else starts a run here.
      !(
        localAutomationRuns &&
        command.type === "message.dispatch" &&
        command.scheduledTaskId !== undefined
      )
        ? Effect.fail(
            new Orchestrator.OrchestratorCommandRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              cause: new Error(LOCAL_AGENT_RUNS_DISABLED_MESSAGE),
            }),
          )
        : Effect.void,
);
