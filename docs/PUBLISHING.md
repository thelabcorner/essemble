# Publishing ESsemble

ESsemble is a standalone framework repository whose dependencies remain
independently versioned and distributed. Do not replace nested Git submodules
with copied source files during publication.

## Preflight

From the ESsemble checkout:

```bash
npm ci --ignore-scripts
npm run validate
npm test
npm run readme:check
npm run publication:audit
npm run publication:audit:remote
npm pack --dry-run --ignore-scripts
git status --short --branch
```

The local publication audit reads the staged Gitlinks, `.gitmodules`, and
`essemble.lock.json`; it does not modify nested repositories. The remote
mode checks that GitHub can serve each exact revision, including revisions
which are no longer the upstream HEAD.

The workspace-wide README synchronization script is optional and may touch
**other repositories**. Within ESsemble, `npm run readme:table` updates only
this repository's canonical toolkit table. The opt-in
`python scripts/sync-toolkit-table.py --check --include-components` reports
drift in nested README files without changing them. Never use
`--write --include-components` merely to make ESsemble's CI green.

### Synchronizing the independent ES* GitHub READMEs

The historical `/scripts/sync_toolkit_readmes.py` wrapper targets
`agent-skills/readme-spec/scripts/sync-toolkit-table.py`, which may be absent
in a slimmed-down workspace. The repository-local canonical table lives in
`scripts/sync-toolkit-table.py`, and the remote synchronizer uses that same
single-source definition:

```bash
# Read-only audit across all linked ES* repositories, including ESsemble.
python scripts/sync-es-repo-readmes.py --check

# Optional focused preview of exact proposed README changes.
python scripts/sync-es-repo-readmes.py --check --repos eson,essemble --diff

# Explicit, authenticated publication across all 22 linked repositories.
python scripts/sync-es-repo-readmes.py --publish

# Verify remote README content again after publication.
python scripts/sync-es-repo-readmes.py --check
```

The synchronizer requires an authenticated `gh` CLI with repository write
permissions. It operates on the current default-branch README of each
independent repository using the GitHub Contents API, a current content SHA
lease, and post-write content verification. It **never modifies local sibling
working trees**, stages their unrelated edits, force pushes, or rewrites the
independently versioned submodules. It writes only the canonical toolkit table
section and preserves other README text and newline conventions. This is a
cross-repository documentation operation: inspect the target list and diff
before passing `--publish`. A failed repository reports an error, does not
roll back previously verified changes to other repositories, and can be
retried idempotently. ESOBF remains excluded until it is publicly published.

## GitHub publication

Publish the parent repository to `thelabcorner/essemble`. The local `origin`
may already point to it even if GitHub has not yet created the repository.
Once the owner's GitHub authentication is working, inspect remote state:

```bash
gh auth status
gh repo view thelabcorner/essemble
```

If the remote repository does not exist, create it intentionally under the
correct account. Do not initialize it with a separate README, .gitignore,
or license, since those files would create divergent Git history:

```bash
gh repo create thelabcorner/essemble --public --description "Extensible framework for Adobe ExtendScript development"
git push --set-upstream origin main
```

If the repository already exists, inspect its default branch before pushing
to avoid overwriting someone else's changes. Never force-push. After the
push, verify that the remote `main` commit matches the local commit and
that CI passed on both supported operating systems.

An owner's GitHub token or interactive sign-in may be required. Do not
embed credentials into the repository, remotes, source files, or logs.
Connection and account authorization must be completed by the repository
owner. If GitHub rate limits a creation request, retry only after access is
restored; a local Git commit does not prove publication.

## Licensing and follow-up releases

This developer-preview checkout has no root `LICENSE` file. The owner must
choose and add the appropriate terms before presenting the source as
licensed open-source software; public GitHub visibility alone does not
grant redistribution or modification rights.

Publishing this Git repository does not publish the `essemble` npm package
or any of its component libraries. npm release credentials, version
management, package licensing, and release tags are separate decisions.

Keep independently maintained components on their pinned, fetchable
revisions, including when HEAD advances. Update exact pins only through
explicit dependency review, compatibility verification, and a separate
commit.