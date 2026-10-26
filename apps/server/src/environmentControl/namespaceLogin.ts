// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - this adapter owns the Namespace CLI's login process and bounds it by wall-clock deadlines.
import * as NodeChildProcess from "node:child_process";
import type { NamespaceAccount } from "@t3tools/contracts";

/** How long a sign-in waits for the user to approve it. */
const SIGN_IN_WINDOW_MS = 10 * 60_000;
/** How long the CLI gets to print its approval page, or to answer a status check. */
const CLI_ANSWER_MS = 30_000;
/** The code follows the page a moment later on the CLI's output. */
const CODE_GRACE_MS = 1_000;

/** Reads `devbox auth check`, which exits 0 whether or not the host is signed in. */
export function parseAuthCheck(output: string): NamespaceAccount {
  if (!/^Logged in\./m.test(output)) return { state: "signed-out" };
  const tenantId = /^\s*Tenant:\s*(\S+)/m.exec(output)?.[1];
  const expiresAt = /^\s*Expires:\s*(\S+)/m.exec(output)?.[1];
  return {
    state: "signed-in",
    ...(tenantId ? { tenantId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * The approval page and verification code `devbox login --browser=false` prints. Only a page on
 * Namespace's own site counts, since a client opens it.
 */
export function parseSignInPrompt(output: string): { url: string; code?: string } | null {
  for (const [candidate] of output.matchAll(/https:\/\/\S+/g)) {
    const url = URL.parse(candidate);
    if (url?.hostname !== "namespace.so" && !url?.hostname.endsWith(".namespace.so")) continue;
    const code = /Verification code:\s*(\S+)/.exec(output)?.[1];
    return { url: url.href, ...(code ? { code } : {}) };
  }
  return null;
}

const unavailable = (error: unknown): NamespaceAccount => ({
  state: "unavailable",
  message:
    (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "The devbox CLI is not installed on this host. Install it from namespace.so, then sign in."
      : "The Namespace CLI did not answer. Try again shortly.",
});

/**
 * Signs this host in to Namespace through the devbox CLI, which saves the login where the
 * Namespace SDK and every later CLI call read it. One sign-in waits for the user at a time.
 */
export function makeNamespaceLogin(options: {
  readonly cli?: string;
  /** Called once a sign-in completes, so sessions opened under the old login are dropped. */
  readonly onSignedIn: () => void;
  readonly windowMs?: number;
}) {
  const cli = options.cli ?? "devbox";
  let pending:
    | {
        readonly url: string;
        readonly code?: string;
        readonly child: NodeChildProcess.ChildProcess;
      }
    | undefined;

  const signingIn = (): NamespaceAccount | null =>
    pending
      ? {
          state: "signing-in",
          url: pending.url,
          ...(pending.code ? { code: pending.code } : {}),
        }
      : null;

  const status = (): Promise<NamespaceAccount> => {
    const waiting = signingIn();
    if (waiting) return Promise.resolve(waiting);
    return new Promise((resolve) => {
      NodeChildProcess.execFile(
        cli,
        ["auth", "check"],
        { timeout: CLI_ANSWER_MS, env: process.env },
        (error, stdout, stderr) =>
          resolve(error ? unavailable(error) : parseAuthCheck(`${stdout}\n${stderr}`)),
      );
    });
  };

  const signIn = (): Promise<NamespaceAccount> => {
    const waiting = signingIn();
    if (waiting) return Promise.resolve(waiting);
    return new Promise((resolve) => {
      const child = NodeChildProcess.spawn(cli, ["login", "--browser=false"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let answered = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const answerTimer = setTimeout(() => {
        child.kill("SIGKILL");
        answer(unavailable(undefined));
      }, CLI_ANSWER_MS);
      const windowTimer = setTimeout(
        () => child.kill("SIGKILL"),
        options.windowMs ?? SIGN_IN_WINDOW_MS,
      );
      const answer = (account: NamespaceAccount) => {
        if (answered) return;
        answered = true;
        clearTimeout(graceTimer);
        clearTimeout(answerTimer);
        resolve(account);
      };
      const offer = () => {
        const prompt = parseSignInPrompt(output);
        if (!prompt) return;
        pending = { ...prompt, child };
        if (prompt.code) answer(signingIn()!);
        else graceTimer ??= setTimeout(() => answer(signingIn()!), CODE_GRACE_MS);
      };
      const read = (data: string) => {
        output += data;
        if (!answered) offer();
      };
      child.stdout.setEncoding("utf8").on("data", read);
      child.stderr.setEncoding("utf8").on("data", read);
      child.once("error", (error) => answer(unavailable(error)));
      child.once("close", (code) => {
        clearTimeout(windowTimer);
        if (pending?.child === child) pending = undefined;
        if (code === 0) options.onSignedIn();
        // A CLI that exits before printing a page was already signed in, or failed outright.
        if (!answered) void status().then(answer);
      });
    });
  };

  return {
    status,
    signIn,
    /** Ends a sign-in still waiting for the user. */
    close: () => {
      pending?.child.kill("SIGKILL");
      pending = undefined;
    },
  };
}
