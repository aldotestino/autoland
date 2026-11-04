# Changesets

Use Changesets to record release intent for `@aldotestino/autoland`.

## Create A Changeset

```bash
bun run changeset
```

Select the release level, then commit the generated `.changeset/*.md` file with
the code change.

Do not run `bun run version-packages` as part of the normal contribution flow.
That command consumes pending changesets and is run by the release workflow.

## Release

After a changeset reaches `main`, `.github/workflows/release.yml` creates or
updates a release PR. That PR contains the version update, the changelog, and
deletion of the consumed changeset files.

Merging the release PR publishes through npm trusted publishing: first the
compiled binary for each platform, then the launcher that depends on them.
Changesets then creates a `vX.Y.Z` Git tag and GitHub Release.
