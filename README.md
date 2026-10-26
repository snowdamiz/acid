# Acid

Acid is an "agent harness control surface": one place to drive the coding agents on your machines from the desktop app, the web app, or your phone. It works with the agent subscriptions you already have (Claude Code, Codex, Cursor, Grok Build, OpenCode, Antigravity).

Acid is a fork of [andrewcai8/t3code](https://github.com/andrewcai8/t3code), which is itself a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). On top of upstream it adds cloud provisioning: a chat can create its own machine on E2B, Modal or Namespace, with forks, backups, warm bases, `t3 fork-exec`, a client-side load balancer across hosts, and storage cleanup.

> [!WARNING]
> Never run upstream's `t3 update` or `t3 service install` on an Acid host, and never install the upstream T3 Code desktop app over Acid. They replace this fork with pingdotgg's build. Hosts run this fork's runtime artifact (`runtime-linux-amd64.tar.gz` from this repo's releases, or one built locally).

The internal names are kept so upstream keeps merging cleanly: the CLI is still `t3`, data still lives in `~/.t3`, packages are still `@t3tools/*`, and environment variables still start with `T3CODE_`.

## Providers

Install and sign in to at least one provider on each host:

- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**

## Building from source

Acid uses [Vite+](https://viteplus.dev/guide/). Install the global `vp` command, then the dependencies (Node 26.12.1, pinned in `package.json`):

```bash
curl -fsSL https://vite.plus | bash
```

```bash
vp i
```

Run the server and web app in development:

```bash
vp run dev
```

Build the host runtime artifact (what hosts install):

```bash
vp run build:t3-runtime-artifact
```

Build the macOS desktop app:

```bash
vp run dist:desktop:dmg:arm64
```

## Releases

- **Runtime artifacts:** pushing a `runtime-v*` tag (or running the _Runtime artifact_ workflow) publishes `runtime-linux-amd64.tar.gz` and `runtime-lockfile.tar.gz` with their sha256 sums.
- **pstack skills:** the _pstack skills_ workflow republishes [chhoumann/t3-pstack](https://github.com/chhoumann/t3-pstack) daily as the `pstack-skills` release that hosts pull through `provisioning.skills[].url`.
- **Upstream:** the _Sync upstream_ workflow opens a daily pull request merging `andrewcai8/t3code`. Merge it with a merge commit, never a squash.

GitHub disables Actions on new forks: enable them under the repository's **Actions** tab before these workflows run.

## Documentation

Docs live in [docs/](./docs).

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Run as a background service](./docs/user/background-service.md)
- [Multiple Claude accounts](./docs/user/providers-claude.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [Internals overview](./docs/internals/overview.md)

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Land pull requests with `gh pr merge --merge`.

## License

MIT. See [LICENSE](./LICENSE). Acid keeps the upstream copyright notice.
