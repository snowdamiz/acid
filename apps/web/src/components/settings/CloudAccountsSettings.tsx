import { useAtomValue } from "@effect/atom-react";
import type {
  CloudCredentialsSettings,
  CloudSessionFiles,
  EnvironmentId,
  NamespaceAccount,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SecretInput } from "./SecretInput";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const readCloudCredentials = (settings: UnifiedSettings): CloudCredentialsSettings =>
  settings.cloudCredentials;
const readPublicWebhookOrigin = (settings: UnifiedSettings): string => settings.publicWebhookOrigin;

/** The host accepts an HTTPS URL, path included, and ignores anything with credentials or a query. */
function isPublicWebhookBase(value: string): boolean {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <InlineButton render={<a href={href} target="_blank" rel="noreferrer noopener" />}>
      {children}
      <ExternalLinkIcon aria-hidden className="size-3" />
    </InlineButton>
  );
}

/**
 * One credential: a field, its explanation, and Save or Remove. A plain field starts from its saved
 * value, so give it that value as its key to start over when it changes.
 */
function CredentialRow({
  id,
  title,
  description,
  secret,
  saved,
  placeholder,
  invalid,
  onSave,
}: {
  id: string;
  title: string;
  description: ReactNode;
  secret: boolean;
  /** A secret's redaction marker, or a plain value as saved. */
  saved: string;
  placeholder?: string;
  invalid?: (draft: string) => string | null;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(secret ? "" : saved);
  const [saving, setSaving] = useState(false);
  const trimmed = draft.trim();
  const problem = trimmed && invalid ? invalid(trimmed) : null;
  const save = async (value: string) => {
    setSaving(true);
    const ok = await onSave(value);
    setSaving(false);
    if (ok && secret) setDraft("");
  };
  return (
    <form
      className="grid gap-2 border-t border-border px-4 py-3 first:border-t-0"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && !problem) void save(trimmed);
      }}
    >
      {/* Locked while saving: a successful save clears the draft, which would drop edits made mid-request. */}
      <fieldset disabled={saving} className="contents">
        <Label htmlFor={id}>{title}</Label>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        <div className="flex items-center gap-2">
          {secret ? (
            <SecretInput
              id={id}
              size="sm"
              configured={saved.length > 0}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <Input
              id={id}
              size="sm"
              autoComplete="off"
              spellCheck={false}
              placeholder={placeholder}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          )}
          {saved.length > 0 ? (
            <Button size="xs" variant="outline" onClick={() => void save("")}>
              Remove
            </Button>
          ) : null}
          <Button
            type="submit"
            size="xs"
            disabled={!trimmed || problem !== null || (!secret && trimmed === saved)}
          >
            Save
          </Button>
        </div>
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      </fieldset>
    </form>
  );
}

function namespaceStatus(account: NamespaceAccount | null, error: string | null): string {
  if (error) return "The host could not read its Namespace login.";
  switch (account?.state) {
    case undefined:
      return "Checking…";
    case "signed-in": {
      const until = account.expiresAt ? new Date(account.expiresAt) : null;
      return [
        "Signed in",
        account.tenantId ? `to workspace ${account.tenantId}` : null,
        until && !Number.isNaN(until.getTime()) ? `until ${until.toLocaleDateString()}` : null,
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "signed-out":
      return "Not signed in.";
    case "signing-in":
      return account.code
        ? `Waiting for approval. Approve only if the page shows ${account.code}.`
        : "Waiting for approval in the browser.";
    case "unavailable":
      return account.message;
  }
}

/**
 * Namespace has no API key that can create Devboxes, so the host signs in through the browser and
 * keeps that login, renewing it as it goes.
 */
function NamespaceAccountRow({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.namespaceAccount({ environmentId, input: {} }),
  );
  const signIn = useAtomCommand(serverEnvironment.signInToNamespace, {
    label: "sign in to Namespace",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const account = query.data;
  const waiting = account?.state === "signing-in";
  // The host learns of the approval when the CLI exits, so poll until it does.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(query.refresh, 3_000);
    return () => clearInterval(timer);
  }, [waiting, query.refresh]);
  const open = async (url: string) => {
    try {
      await ensureLocalApi().shell.openExternal(url);
      setProblem(null);
    } catch {
      setProblem("Could not open the page. Use the link below.");
    }
  };
  const start = async () => {
    const result = await signIn({ environmentId, input: {} });
    if (result._tag === "Success" && result.value.state === "signing-in")
      await open(result.value.url);
  };
  return (
    <div className="grid gap-2 border-t border-border px-4 py-3">
      <Label>Namespace</Label>
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Mac machines run on Namespace. Namespace has no API key that can create them, so this host
        signs in through your browser and keeps the login.
      </p>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {namespaceStatus(account, query.error)}
        </p>
        {waiting ? (
          <Button size="xs" variant="outline" onClick={() => void open(account.url)}>
            Open approval page
          </Button>
        ) : (
          <Button
            size="xs"
            variant={account?.state === "signed-in" ? "outline" : "default"}
            disabled={account === null || account.state === "unavailable"}
            onClick={() => void start()}
          >
            {account?.state === "signed-in" ? "Switch account" : "Sign in"}
          </Button>
        )}
      </div>
      {waiting ? (
        <p className="break-all text-xs text-muted-foreground">
          <ExternalLink href={account.url}>{account.url}</ExternalLink>
        </p>
      ) : null}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
    </div>
  );
}

function syncedLoginsStatus(synced: CloudSessionFiles | null, error: string | null): string {
  if (error) return "The host could not read the synced logins.";
  if (synced === null) return "Checking…";
  if (synced.files.length === 0) return "No computer syncs its logins here.";
  const at = synced.syncedAt ? new Date(synced.syncedAt) : null;
  return [
    `${synced.files.length} ${synced.files.length === 1 ? "file" : "files"}`,
    synced.device ? `from ${synced.device}` : null,
    at && !Number.isNaN(at.getTime()) ? `synced ${at.toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Logins a computer syncs with `t3 sessions`. Clearing them here removes them from every cloud
 * machine; the computer puts them back on its next sync unless `t3 sessions remove` ran there.
 */
function SyncedLoginsRow({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(serverEnvironment.sessionFiles({ environmentId, input: {} }));
  const canClear = useAtomValue(serverEnvironment.clearSessionFiles.permissionAtom(environmentId));
  const clear = useAtomCommand(serverEnvironment.clearSessionFiles, {
    label: "clear synced CLI logins",
  });
  const synced = query.data;
  return (
    <div className="grid gap-2 border-t border-border px-4 py-3">
      <Label>CLI logins from your computer</Label>
      <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Agents on every cloud machine get the AWS, gcloud, kubectl and npm logins your computer
        syncs here, so logging in on your computer logs them in too. Connect a computer by running{" "}
        <code>t3 sessions setup --host &lt;this host&gt; --token &lt;token&gt;</code> on it.
      </p>
      <div className="flex items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {syncedLoginsStatus(synced, query.error)}
        </p>
        <Button
          size="xs"
          variant="outline"
          disabled={!canClear || !synced || synced.files.length === 0}
          onClick={() => void clear({ environmentId, input: {} })}
        >
          Clear
        </Button>
      </div>
      {synced && synced.files.length > 0 ? (
        <p className="break-all text-xs text-muted-foreground">
          {synced.files.map((file) => file.path).join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function HostCloudAccounts({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string | null;
}) {
  const credentials = useEnvironmentSettings(environmentId, readCloudCredentials);
  const publicWebhookOrigin = useEnvironmentSettings(environmentId, readPublicWebhookOrigin);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save cloud account",
  });
  const save = async (patch: ServerSettingsPatch) =>
    (await updateSettings({ environmentId, input: { patch } }))._tag === "Success";
  return (
    <>
      {label ? <p className="px-4 pt-3 text-xs font-medium">{label}</p> : null}
      <CredentialRow
        id={`e2b-api-key-${environmentId}`}
        title="E2B API key"
        secret
        saved={credentials.e2bApiKey}
        description={
          <>
            Linux machines run on E2B. A key saved here is used before the one in
            environment-control.json.{" "}
            <ExternalLink href="https://e2b.dev/dashboard?tab=keys">Get a key</ExternalLink>
          </>
        }
        onSave={(value) => save({ cloudCredentials: { e2bApiKey: value } })}
      />
      <CredentialRow
        id={`github-token-cloud-${environmentId}`}
        title="GitHub token"
        secret
        saved={credentials.githubToken}
        description={
          <>
            What cloud machines clone private repositories, push and open pull requests with. Give
            it read and write access to contents and pull requests.{" "}
            <ExternalLink href="https://github.com/settings/personal-access-tokens/new">
              Create a token
            </ExternalLink>
          </>
        }
        onSave={(value) => save({ cloudCredentials: { githubToken: value } })}
      />
      <NamespaceAccountRow environmentId={environmentId} />
      <SyncedLoginsRow environmentId={environmentId} />
      <CredentialRow
        id={`sentry-auth-token-${environmentId}`}
        title="Sentry auth token"
        secret
        saved={credentials.sentryAuthToken}
        description={
          <>
            Given to agents on every cloud machine as SENTRY_AUTH_TOKEN, so they can read the Sentry
            issues they are sent to fix. A user token with event:read, project:read and org:read is
            enough; organization tokens cannot read issues. Machines started after saving get it.{" "}
            <ExternalLink href="https://sentry.io/settings/account/api/auth-tokens/">
              Create a token
            </ExternalLink>
          </>
        }
        onSave={(value) => save({ cloudCredentials: { sentryAuthToken: value } })}
      />
      <CredentialRow
        key={`sentry-org:${credentials.sentryOrg}`}
        id={`sentry-org-${environmentId}`}
        title="Sentry organization"
        secret={false}
        saved={credentials.sentryOrg}
        placeholder="my-org"
        description="The organization slug, given to agents as SENTRY_ORG."
        onSave={(value) => save({ cloudCredentials: { sentryOrg: value } })}
      />
      <CredentialRow
        key={`public-webhook-origin:${publicWebhookOrigin}`}
        id={`public-webhook-origin-${environmentId}`}
        title="Public webhook URL"
        secret={false}
        saved={publicWebhookOrigin}
        placeholder="https://hooks.example.com"
        invalid={(draft) =>
          isPublicWebhookBase(draft)
            ? null
            : "Enter an HTTPS URL with no query, such as a tunnel's."
        }
        description="An HTTPS URL that forwards its path plus /api/hooks/* to this host, such as a Cloudflare Tunnel. Webhook tasks show their URL under it, so services like Sentry can reach them."
        onSave={(value) => save({ publicWebhookOrigin: value })}
      />
    </>
  );
}

/** The accounts each connected host that provisions cloud machines starts them with. */
export function CloudAccountsSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const managers = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environmentControl === true,
  );
  if (managers.length === 0) return null;
  return (
    <SettingsSection {...searchableSetting("cloud-accounts")} title="Cloud accounts">
      {managers.map((environment) => (
        <HostCloudAccounts
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={managers.length > 1 ? environment.label : null}
        />
      ))}
    </SettingsSection>
  );
}
