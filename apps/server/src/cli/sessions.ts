/**
 * `t3 sessions`: keeps the CLI logins on this computer (AWS SSO, gcloud, kubectl, npm) on an Acid
 * host, which writes them into every cloud machine it runs. Log in here, and cloud agents inherit
 * it.
 *
 * @module cli/sessions
 */
import {
  CloudSessionFiles,
  CloudSessionFilesUpload,
  type HomeFile,
  HomeRelativePath,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

/** Where the common CLIs keep their logins, relative to the home. Missing ones are skipped. */
const DEFAULT_SESSION_PATHS = [
  ".aws/config",
  ".aws/credentials",
  ".aws/sso/cache",
  ".aws/cli/cache",
  ".config/gcloud/active_config",
  ".config/gcloud/configurations",
  ".config/gcloud/credentials.db",
  ".config/gcloud/access_tokens.db",
  ".config/gcloud/application_default_credentials.json",
  ".kube/config",
  ".npmrc",
];

const LAUNCH_AGENT_LABEL = "app.acid.session-sync";
/** Pushes again this often whether or not launchd saw a change, in seconds. */
const PUSH_INTERVAL_SECONDS = 30 * 60;

const SessionSyncConfig = Schema.Struct({
  host: Schema.String,
  token: Schema.String,
  paths: Schema.Array(HomeRelativePath),
});
type SessionSyncConfig = typeof SessionSyncConfig.Type;
const SessionSyncConfigJson = Schema.fromJsonString(SessionSyncConfig);
const decodeSessionSyncConfig = Schema.decodeEffect(SessionSyncConfigJson);
const encodeSessionSyncConfig = Schema.encodeEffect(SessionSyncConfigJson);
const encodeUpload = Schema.encodeEffect(Schema.fromJsonString(CloudSessionFilesUpload));
const decodeHomePaths = Schema.decodeUnknownEffect(Schema.Array(HomeRelativePath));

export class SessionSyncError extends Schema.TaggedError<SessionSyncError>()("SessionSyncError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const configPath = (baseDir: string) =>
  Effect.map(Path.Path, (path) => path.join(baseDir, "session-sync.json"));

const readConfig = Effect.fn("sessions.readConfig")(function* (baseDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* configPath(baseDir)).pipe(
    Effect.mapError(
      () =>
        new SessionSyncError({
          detail: "This computer is not set up to sync. Run `t3 sessions setup` first.",
        }),
    ),
  );
  return yield* decodeSessionSyncConfig(text).pipe(
    Effect.mapError(
      () => new SessionSyncError({ detail: "session-sync.json is unreadable. Run setup again." }),
    ),
  );
});

/**
 * Every regular file under the given home paths. A directory contributes what it holds, at any
 * depth, keeping each file's permission bits.
 */
export const collectHomeFiles = Effect.fn("sessions.collectHomeFiles")(function* (
  home: string,
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, HomeFile>();
  const add = Effect.fnUntraced(function* (relative: string) {
    const info = yield* fs.stat(path.join(home, relative)).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") return;
    const contents = yield* fs.readFile(path.join(home, relative));
    files.set(relative, {
      path: relative,
      contentsBase64: Buffer.from(contents).toString("base64"),
      mode: info.value.mode & 0o777,
    });
  });
  for (const entry of paths) {
    const info = yield* fs.stat(path.join(home, entry)).pipe(Effect.option);
    if (Option.isNone(info)) continue;
    if (info.value.type === "Directory") {
      const nested = yield* fs.readDirectory(path.join(home, entry), { recursive: true });
      for (const child of nested) yield* add(`${entry}/${child.split(path.sep).join("/")}`);
    } else yield* add(entry);
  }
  return [...files.values()];
});

const sessionFilesUrl = (host: string) =>
  `${host.replace(/\/+$/, "")}/api/environment-control/session-files`;

const upload = Effect.fn("sessions.upload")(function* (
  config: SessionSyncConfig,
  files: ReadonlyArray<HomeFile>,
) {
  const client = yield* HttpClient.HttpClient;
  const body = yield* encodeUpload({
    device: yield* HostProcess.Hostname,
    files,
  }).pipe(
    Effect.mapError(
      (cause) => new SessionSyncError({ detail: `These files cannot be synced: ${cause.message}` }),
    ),
  );
  const response = yield* client
    .execute(
      HttpClientRequest.put(sessionFilesUrl(config.host)).pipe(
        HttpClientRequest.bearerToken(config.token),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SessionSyncError({ detail: `${config.host} did not answer: ${cause.message}` }),
      ),
    );
  if (response.status === 401 || response.status === 403)
    return yield* new SessionSyncError({
      detail: `${config.host} refused this computer's token. Run \`t3 sessions setup\` with a new one.`,
    });
  if (response.status === 404)
    return yield* new SessionSyncError({
      detail: `${config.host} does not take synced logins. Update it, or check the address.`,
    });
  return yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(CloudSessionFiles)),
    Effect.mapError(
      () =>
        new SessionSyncError({
          detail: `${config.host} could not save the logins (status ${response.status}).`,
        }),
    ),
  );
});

const push = Effect.fn("sessions.push")(function* (config: SessionSyncConfig) {
  const files = yield* collectHomeFiles(yield* HostProcess.HomeDirectory, config.paths);
  const saved = yield* upload(config, files);
  yield* Console.log(
    saved.files.length === 0
      ? `No logins found here to sync to ${config.host}.`
      : `Synced ${saved.files.length} files to ${config.host}: ${saved.files.map((file) => file.path).join(", ")}`,
  );
});

/** How launchd starts this CLI again: the desktop app's launcher when it has one. */
const cliProgram = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  if (env.T3CODE_CLI_PATH) return [env.T3CODE_CLI_PATH];
  const executable = yield* HostProcess.ExecutablePath;
  if (yield* HostProcess.IsExecutable) return [executable];
  const entry = (yield* HostProcess.Arguments)[1];
  return entry ? [executable, entry] : [executable];
});

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const renderLaunchAgent = (input: {
  readonly program: ReadonlyArray<string>;
  readonly baseDir: string;
  readonly watch: ReadonlyArray<string>;
  readonly log: string;
}) => {
  const strings = (values: ReadonlyArray<string>) =>
    values.map((value) => `<string>${xml(value)}</string>`).join("");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `<key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    `<key>ProgramArguments</key><array>${strings([...input.program, "sessions", "push"])}</array>`,
    `<key>EnvironmentVariables</key><dict><key>T3CODE_HOME</key><string>${xml(input.baseDir)}</string></dict>`,
    `<key>WatchPaths</key><array>${strings(input.watch)}</array>`,
    `<key>StartInterval</key><integer>${PUSH_INTERVAL_SECONDS}</integer>`,
    `<key>RunAtLoad</key><true/>`,
    `<key>StandardOutPath</key><string>${xml(input.log)}</string>`,
    `<key>StandardErrorPath</key><string>${xml(input.log)}</string>`,
    `</dict></plist>`,
    "",
  ].join("\n");
};

/** Each synced path, or the nearest folder of it that exists, so a first login is noticed too. */
const watchPaths = Effect.fn("sessions.watchPaths")(function* (
  home: string,
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const watched = new Set<string>();
  for (const entry of paths) {
    for (let candidate = entry; candidate !== "."; candidate = path.dirname(candidate)) {
      if (yield* fs.exists(path.join(home, candidate)).pipe(Effect.orElseSucceed(() => false))) {
        watched.add(path.join(home, candidate));
        break;
      }
    }
  }
  return [...watched];
});

const launchctl = Effect.fn("sessions.launchctl")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make("launchctl", args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    )
    .pipe(Effect.orElseSucceed(() => 1));
});

const launchAgentPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(
    yield* HostProcess.HomeDirectory,
    "Library",
    "LaunchAgents",
    `${LAUNCH_AGENT_LABEL}.plist`,
  );
});

const installLaunchAgent = Effect.fn("sessions.installLaunchAgent")(function* (
  baseDir: string,
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const plist = yield* launchAgentPath;
  const domain = `gui/${yield* HostProcess.UserId}`;
  yield* fs.makeDirectory(path.dirname(plist), { recursive: true });
  yield* fs.makeDirectory(path.join(baseDir, "logs"), { recursive: true });
  yield* fs.writeFileString(
    plist,
    renderLaunchAgent({
      program: yield* cliProgram,
      baseDir,
      watch: yield* watchPaths(yield* HostProcess.HomeDirectory, paths),
      log: path.join(baseDir, "logs", "session-sync.log"),
    }),
  );
  yield* launchctl(["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  if ((yield* launchctl(["bootstrap", domain, plist])) !== 0)
    return yield* new SessionSyncError({ detail: `launchd did not load ${plist}.` });
});

const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("The Acid host's address, such as https://acid.example.com."),
);
const tokenFlag = Flag.String("token").pipe(
  Flag.withDescription("A token for the host with settings:write scope."),
);
const pathFlag = Flag.String("path").pipe(
  Flag.withDescription(
    `A file or folder under your home to sync. Repeat for several; replaces the default set: ${DEFAULT_SESSION_PATHS.join(", ")}.`,
  ),
  Flag.atLeast(0),
);

const setupCommand = Command.make("setup", {
  baseDir: baseDirFlag,
  host: hostFlag,
  token: tokenFlag,
  path: pathFlag,
}).pipe(
  Command.withDescription(
    "Sync this computer's CLI logins to an Acid host now, and again whenever they change.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
      const paths = yield* decodeHomePaths(
        flags.path.length > 0 ? flags.path : DEFAULT_SESSION_PATHS,
      ).pipe(
        Effect.mapError(
          () => new SessionSyncError({ detail: "Each --path must be a path inside your home." }),
        ),
      );
      const config: SessionSyncConfig = { host: flags.host, token: flags.token, paths };
      // A host that refuses the token fails here, before anything is installed.
      yield* push(config);
      yield* fs.makeDirectory(baseDir, { recursive: true });
      const file = yield* configPath(baseDir);
      yield* fs.writeFileString(file, yield* encodeSessionSyncConfig(config));
      yield* fs.chmod(file, 0o600);
      if ((yield* HostProcess.Platform) !== "darwin") {
        yield* Console.log(
          "Run `t3 sessions push` after you log in to a CLI, or from cron, to sync again.",
        );
        return;
      }
      yield* installLaunchAgent(baseDir, paths);
      yield* Console.log("This Mac now syncs its CLI logins whenever they change.");
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const pushCommand = Command.make("push", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Sync this computer's CLI logins to its Acid host now."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
      yield* push(yield* readConfig(baseDir));
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const removeCommand = Command.make("remove", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Stop syncing, and remove this computer's logins from the host and its cloud machines.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
      const config = yield* readConfig(baseDir);
      if ((yield* HostProcess.Platform) === "darwin") {
        yield* launchctl(["bootout", `gui/${yield* HostProcess.UserId}/${LAUNCH_AGENT_LABEL}`]);
        yield* fs.remove(yield* launchAgentPath, { force: true });
      }
      yield* upload(config, []);
      yield* fs.remove(yield* configPath(baseDir), { force: true });
      yield* Console.log(
        `Stopped syncing. ${config.host} and its cloud machines no longer keep these logins.`,
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

export const sessionsCommand = Command.make("sessions").pipe(
  Command.withDescription("Sync this computer's CLI logins to the cloud machines of an Acid host."),
  Command.withSubcommands([setupCommand, pushCommand, removeCommand]),
);
