# Blamit

A deliberately minimal alternative to GitLens: see who last changed the current line, and open the commit or the merge/pull request that introduced it in your browser.

No side panels, no graphs, no runtime dependencies.

## Features

- **Current line blame**: `Author, 3 days ago • Commit summary` at the end of the line under the cursor. Unsaved edits are taken into account.
- **Hover** over the annotation: full commit message, author, date, and links to open the commit or the MR/PR.
- **Commands** (Command Palette and editor context menu), applied to the cursor line:
  - `Blamit: Open Commit`
  - `Blamit: Open MR/PR`
  - `Blamit: Copy SHA`
  - `Blamit: Set API Token`

## Supported hosts

GitHub, GitLab and Gitea/Forgejo, including self-hosted instances. The host type is detected from the remote URL (a hostname containing `github`, `gitlab`, `gitea` or `forgejo`). For other hostnames, or for SSH aliases from `~/.ssh/config`, use the `blamit.hosts` setting:

```json
"blamit.hosts": {
  "git.example.com": "gitea",
  "github-work": { "type": "github", "url": "https://github.com" }
}
```

## Finding the MR/PR

1. **Locally, without network**: the commit message itself (squash merges: `Title (#123)`, `See merge request group/project!123`), then the message of the merge commit that brought the commit into the current branch.
2. **Through the API**, only if a token is set for the host with `Blamit: Set API Token`. Tokens are kept in VS Code's secret storage and only sent to that host.

Minimal token scopes:

| Host | Scope |
|---|---|
| GitHub | Fine-grained token with *Pull requests: read* (classic: `repo` for private repositories) |
| GitLab | `read_api` |
| Gitea / Forgejo | `read:repository` |

Without a token, commits merged by rebase or fast-forward with no reference in their message have no MR/PR to find: you are offered to open the commit instead.

## Settings

| Setting | Default | Description |
|---|---|---|
| `blamit.enabled` | `true` | Show the current line blame |
| `blamit.remote` | `"origin"` | Remote used to build URLs (falls back to the first remote) |
| `blamit.hosts` | `{}` | Host type (and optionally web URL) for self-hosted instances and SSH aliases |

## Requirements and security

- Git must be installed. Blamit uses the git executable found by VS Code's built-in Git extension.
- Blamit is disabled in untrusted workspaces (Restricted Mode), because git can run code configured by a repository.
- Logs: *Output* panel → *Blamit*.

## License

MIT

The icon is the [Git logo](https://git-scm.com/downloads/logos) by Jason Long, licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
