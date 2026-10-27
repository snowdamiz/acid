import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  WS_METHODS,
} from "@t3tools/contracts";

/**
 * Cloud machine RPCs: reading the list needs read scope, anything that runs or changes one operate.
 * Signing the host in to Namespace changes the account its Macs bill to, which is a setting, as
 * the CLI logins every machine is given are.
 */
export const ENVIRONMENT_CONTROL_REQUIRED_SCOPES = {
  [WS_METHODS.environmentControlListProvisioned]: AuthOrchestrationReadScope,
  [WS_METHODS.environmentControlList]: AuthOrchestrationReadScope,
  [WS_METHODS.environmentControlStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlProvision]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlAttach]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlDispose]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlPause]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlUpgrade]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlSwitchAccount]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlClaim]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlTouch]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlKeep]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlRestore]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlPresence]: AuthOrchestrationOperateScope,
  [WS_METHODS.environmentControlNamespaceAccount]: AuthOrchestrationReadScope,
  [WS_METHODS.environmentControlNamespaceSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.environmentControlSessionFiles]: AuthOrchestrationReadScope,
  [WS_METHODS.environmentControlClearSessionFiles]: AuthSettingsWriteScope,
} as const;
