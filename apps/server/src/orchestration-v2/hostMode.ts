import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";

// No orchestration imports: provider adapters read these, and the orchestrator imports them.

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
