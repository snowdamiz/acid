import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import { makeHostLaunchThread } from "../orchestration-v2/hostLaunchThread.ts";
import * as ProviderAccountSwitch from "../provider/ProviderAccountSwitch.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import { PROVISION_BROKER_SUBJECT } from "./remotePreparation.ts";
import { writeSyncedHomeFiles } from "./sessionFileSync.ts";

const MAX_PROVISION_BODY_BYTES = 90 * 1024 * 1024;

export const environmentControlBodyLimitLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (!request.url.startsWith("/api/environment-control/")) return yield* httpEffect;
      if (Number(request.headers["content-length"]) > MAX_PROVISION_BODY_BYTES) {
        return HttpServerResponse.jsonUnsafe(
          { error: "payload_too_large", message: "Provisioning request exceeds 90 MiB." },
          { status: 413 },
        );
      }
      return yield* Effect.provideService(
        httpEffect,
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_PROVISION_BODY_BYTES),
      );
    }),
  { global: true },
);

export const environmentControlHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "environmentControl",
  Effect.fnUntraced(function* (handlers) {
    const control = yield* EnvironmentControl.EnvironmentControl;
    const launchThread = yield* makeHostLaunchThread;
    const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return handlers
      .handle("launchThread", (args) =>
        annotateEnvironmentRequest(args.endpoint.name).pipe(
          Effect.andThen(launchThread(args.payload)),
        ),
      )
      .handle(
        "switchAccount",
        Effect.fn("environment.control.switchAccount")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* accounts
            .switchAccount(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "writeHomeFiles",
        Effect.fn("environment.control.writeHomeFiles")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
          // Only a box's host writes into its home: anywhere else this home is a person's own.
          if (session.subject !== PROVISION_BROKER_SUBJECT)
            return yield* failEnvironmentScopeRequired(AuthEnvironmentMaintainScope);
          return yield* Effect.tryPromise(() =>
            writeSyncedHomeFiles(`${stateDir}/synced-home-files.json`, args.payload.files),
          ).pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "uploadSessionFiles",
        Effect.fn("environment.control.uploadSessionFiles")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return yield* control
            .uploadSessionFiles(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "listProvisioned",
        Effect.fn("environment.control.listProvisioned")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* control
            .listProvisioned(undefined, undefined, undefined, args.payload.providers)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "provision",
        Effect.fn("environment.control.provision")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* control
            .provision(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "attach",
        Effect.fn("environment.control.attach")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* control
            .attach(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "claim",
        Effect.fn("environment.control.claim")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* control
            .claim(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "touch",
        Effect.fn("environment.control.touch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* control
            .touch(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "dispose",
        Effect.fn("environment.control.dispose")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* control
            .dispose(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      );
  }),
);
