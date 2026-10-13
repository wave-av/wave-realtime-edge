# wave-realtime-edge on Buildkite (shadow mode)

This directory ports wave-realtime-edge's credential-free GitHub Actions gates to Buildkite, using WAVE's
shared pipeline templates. Nothing under `.github/` changes. The GitHub workflows stay the gate until the
Buildkite pipeline has been green for 7 consecutive days. No Buildkite pipeline exists for this repository
yet; creating one is a separate operator step.

## Fork pull requests

This is a public repository, so anyone can open a pull request from a fork. **Fork pull requests are
refused by the pipeline setting `build_pull_request_forks: false`: Buildkite never starts a build for
them, so fork code never runs on these CI agents.** The tooling that creates the pipeline sets that value
and verifies it on the live pipeline. No step in this directory receives a secret either (see
"Credentials").

## Layout

| path | role |
|---|---|
| pipeline wiring | Not part of this change. The uploader pipeline file, its fixed shim and the template settings are added when WAVE's shared CI templates ship their public-repository profile. Until then nothing in this directory runs on Buildkite. |
| `deferred.json` | NOT rendered. Every GitHub job with no running step yet, with the reason and the blocker (`parked_jobs`). |
| `scripts/<step>.sh` | One script per Buildkite step. Each checks its tools, runs its gates and prints a summary. |
| `scripts/lib/common.sh` | Strict mode, credential hygiene, the gate runner and the summary. |
| `gates/*.gate` | The VERBATIM `run:` bodies of the GitHub steps being replaced, named `<workflow>.<job>.<nn>-<step>.gate`. |

## Why the gates are copies

A gate that runs the same bytes as the GitHub step is a parity claim anyone can check. Each file header
names the workflow, job and step it came from and the commit it was copied at (0f8e3caef8a7). The runner
executes it as `bash -e <file>`, GitHub's default shell, with the step's literal `env:` (`# gh-env:
NAME=value`). To refresh one, copy the step's `run:` body from the workflow unchanged. A failing gate does
not stop the others in its step: every gate runs, then the summary fails the step if any blocking gate
failed.

## Parity: every GitHub Actions job

| GH workflow / job | triggers | Buildkite | notes |
|---|---|---|---|
| `_checks.yml` / `checks` | called by foundation-gate | step `foundation-gate` | secret scan + line-count check (max 800) |
| `_checks.yml` / `skill-validate` | called by foundation-gate | step `foundation-gate` | Python 3.14 + PyYAML, as on GitHub |
| `_checks.yml` / `verify-routes` | called by foundation-gate | step `foundation-gate` | URL convention check on `wrangler.toml` |
| `foundation-gate.yml` / `gate` | PR, push main/master/staging, merge_group | step `foundation-gate` | the caller of the three jobs above |
| `public-repo-guard.yml` / `guard` | PR, push main/master, workflow_dispatch | step `public-repo-guard` | gitleaks 8.30.1, content policy, body-policy fixtures |
| `contract-tests.yml` / `test` | PR, push main/master/staging | parked | private npm packages |
| `contract-tests.yml` / `typecheck` | PR, push main/master/staging | parked | private npm packages |
| `bundle-eval-gate.yml` / `bundle-eval` | PR, push main (paths) | parked | private npm packages |
| `governance-enforce.yml` / `enforce` | PR, push, merge_group | parked | private npm packages |
| `deploy.yml` / `deploy` | workflow_dispatch | parked | deploy: out of scope for this port |
| `issue-ops-triage.yml` / `triage` | issues | parked | GitHub event bot |
| `pr-agent.yml` / `pr_agent` | PR, issue_comment | parked | GitHub event bot |
| `public-repo-guard.yml` / `body-guard` | PR, issues, issue_comment | parked | GitHub event bot (scans PR/issue/comment text) |

13 jobs: 5 ported into 2 steps, 8 parked. Nothing is dropped. No workflow here has a `schedule:` trigger.

## Parked jobs

Each is listed in `deferred.json` with its reason and blocker. The GitHub workflow stays the gate
for these meanwhile.

- **Private npm packages** (`test`, `typecheck`, `bundle-eval`, `enforce`). Each one installs private
  `@wave-av/*` packages (`spoke-chassis`, `governance`) from GitHub Packages, which the Buildkite agents
  cannot read from (HTTP 403). They will come from WAVE's self-hosted npm registry, which is in progress.
  No workaround is used here. When it lands, these become steps; each will then need a registry read
  credential. `bundle-eval` also builds two container images with the job's Docker daemon.
- **Deploy** (`deploy`). Deploy and publish jobs are out of scope for this port.
- **GitHub event bots** (`triage`, `pr_agent`, `body-guard`). They react to GitHub events Buildkite does
  not receive (issues, comments, body edits) or write back to GitHub. They wait for a GitHub-event bridge,
  which is in progress.

## Differences from GitHub, on purpose

- Tools come from the CI image, never from a download in the job: gitleaks 8.30.1 (the version GitHub
  pins; the step fails if the image has another), ripgrep with PCRE2 (the step checks `rg
  --pcre2-version`, as the GitHub install step does), Python 3.14 and PyYAML. The GitHub install steps
  are therefore not copied. If the selected Python lacks PyYAML, the step installs it into a job-local
  venv from PyPI.
- `GUARD_PRIVATE_REPOS` is a GitHub organization variable, and Buildkite cannot read it. Without it,
  `content-policy.sh` skips its private-name rule, exactly as it does on a developer machine; the step
  prints a warning. Every other content-policy rule runs.
- GitHub runs the tree scan again on a PR body edit; Buildkite starts no build for an edit, and the tree
  has not changed, so the verdict is the same.
- `merge_group` has no Buildkite counterpart; merge-queue builds would be ordinary branch builds.
- `harden-runner` steps are specific to GitHub's runners and are not copied; checkouts are the agent's.

## Credentials

No running step declares or receives a secret. `scripts/lib/common.sh` unsets every credential-shaped
name before any gate runs.

## Checking a change locally

Once the pipeline wiring is in place, with a checkout of the template kit at its pinned commit (and
`npm ci` in its `tools/caps-lint`):

```sh
node <kit>/bin/<render script> --settings <settings json> --context <ctx.json> --out-dir <empty dir>
node <kit>/tools/caps-lint/bin/caps-lint.mjs <empty dir>/*.yml .buildkite
```

The step scripts refuse to run outside a Buildkite job (`BUILDKITE=true`).
