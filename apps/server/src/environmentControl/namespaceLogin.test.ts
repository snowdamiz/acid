// @effect-diagnostics nodeBuiltinImport:off - tests drive a stand-in CLI in a temporary directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { makeNamespaceLogin, parseAuthCheck, parseSignInPrompt } from "./namespaceLogin.ts";

it("reads the CLI's login status and sign-in page, trusting only Namespace's own pages", () => {
  expect(parseAuthCheck("Not logged in.\n")).toEqual({ state: "signed-out" });
  expect(
    parseAuthCheck("Logged in.\n  Tenant: tenant_abc\n  Expires: 2026-11-25T12:41:46-05:00\n"),
  ).toEqual({ state: "signed-in", tenantId: "tenant_abc", expiresAt: "2026-11-25T12:41:46-05:00" });
  expect(
    parseSignInPrompt(
      "Open https://evil.example/phish then\n  https://cloud.namespace.so/login/workspace?id=a&code=b\n\nVerification code: AB12-CD34\n",
    ),
  ).toEqual({ url: "https://cloud.namespace.so/login/workspace?id=a&code=b", code: "AB12-CD34" });
  expect(parseSignInPrompt("Open https://namespace.so.evil.example/login")).toBeNull();
});

it("signs in once through the CLI, answers with the waiting sign-in, and reports the new login", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-namespace-login-"));
  const cli = NodePath.join(directory, "devbox");
  // Stands in for the devbox CLI: login prints its page and waits for the approval file.
  await NodeFSP.writeFile(
    cli,
    `#!/bin/sh
state='${directory}'
case "$1" in
  auth) if [ -f "$state/token" ]; then printf 'Logged in.\\n  Tenant: tenant_abc\\n'; else echo 'Not logged in.'; fi ;;
  login)
    echo started >> "$state/logins"
    printf 'Please complete the login flow in your browser.\\n\\n  https://cloud.namespace.so/login/workspace?id=abc&code=XY12\\n\\nVerification code: XY12-ZZ34\\n'
    while [ ! -f "$state/approve" ]; do sleep 0.05; done
    touch "$state/token" ;;
esac
`,
    { mode: 0o755 },
  );
  const signedIn = Promise.withResolvers<void>();
  const login = makeNamespaceLogin({ cli, onSignedIn: () => signedIn.resolve() });
  try {
    expect(await login.status()).toEqual({ state: "signed-out" });
    const waiting = {
      state: "signing-in",
      url: "https://cloud.namespace.so/login/workspace?id=abc&code=XY12",
      code: "XY12-ZZ34",
    };
    expect(await login.signIn()).toEqual(waiting);
    expect(await login.signIn()).toEqual(waiting);
    expect(await login.status()).toEqual(waiting);
    expect((await NodeFSP.readFile(NodePath.join(directory, "logins"), "utf8")).trim()).toBe(
      "started",
    );

    await NodeFSP.writeFile(NodePath.join(directory, "approve"), "");
    await signedIn.promise;
    expect(await login.status()).toEqual({ state: "signed-in", tenantId: "tenant_abc" });
  } finally {
    login.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("says the CLI is missing rather than failing", async () => {
  const login = makeNamespaceLogin({ cli: "/nonexistent/devbox", onSignedIn: () => {} });
  expect(await login.status()).toMatchObject({ state: "unavailable" });
  expect(await login.signIn()).toMatchObject({ state: "unavailable" });
});
