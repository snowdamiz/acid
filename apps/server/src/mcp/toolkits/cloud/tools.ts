import {
  EnvironmentId,
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInteractionMode,
  ProvisionProvider,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { EnvironmentControl } from "../../../environmentControl/EnvironmentControl.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../../../project/RepositoryIdentityResolver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const CloudChatLaunchTool = Tool.make("t3_cloud_chat_launch", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  description:
    "Start an ordinary TOP-LEVEL chat on a fresh cloud machine this host provisions, with message as its first turn. provider 'namespace' is a real Mac with Xcode: use it for work that needs macOS, Xcode, Swift toolchains or the iOS Simulator. provider 'e2b' is a Linux box: use it for heavy or long Linux work such as full builds, test suites or long-running jobs. The machine clones the project's GitHub repository on branch (default: the repository's default branch), so it sees only pushed commits; push first or name a pushed branch. Write message as a complete, self-contained brief: the new chat has none of this conversation. The chat runs on its own machine and shows in the user's sidebar once the machine is ready; status 'starting' means it is still getting ready (about a minute), not that it failed, so never launch it again. This thread cannot read or message that chat afterwards. Model and modes inherit from the calling thread unless passed; the new chat may not run with broader modes than the caller. Fails when this host cannot start that provider, or the project has no GitHub repository.",
  parameters: Schema.Struct({
    provider: ProvisionProvider,
    title: TrimmedNonEmptyString,
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120000)),
    projectId: Schema.optional(ProjectId),
    branch: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    provider: ProvisionProvider,
    repository: Schema.String,
    status: Schema.Literals(["ready", "starting"]),
    environmentId: Schema.optional(EnvironmentId),
  }),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    RepositoryIdentityResolver,
    EnvironmentControl,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const CloudToolkit = Toolkit.make(CloudChatLaunchTool);
