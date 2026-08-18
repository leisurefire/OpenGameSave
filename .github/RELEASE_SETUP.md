# Application release setup

The `Build and Release` workflow deliberately fails closed until these repository values exist:

- Repository secret `WINDOWS_CERTIFICATE`: the PFX certificate as an electron-builder-compatible base64 value or secure URL.
- Repository secret `WINDOWS_CERTIFICATE_PASSWORD`: the PFX password.
- Repository variable `WINDOWS_PUBLISHER_NAME`: the exact certificate simple name used by Authenticode and electron-updater.
- Repository secret `RELEASE_ADMIN_TOKEN`: a fine-grained token with repository Administration and Contents write access. It enables and verifies GitHub immutable releases.

The workflow must also be allowed to push its dedicated release commit to `main`. If branch protection blocks the GitHub Actions identity, grant only this workflow the required bypass instead of weakening protection for all writers.

The reusable `database` Release is created before repository release immutability is enabled because that machine channel advances `current.json`. Application Releases are created as drafts, fully uploaded and verified, and only then published and made immutable.

Stable runs publish `latest.yml` and explicitly become GitHub Latest. Pre-release runs publish `<label>.yml`, are marked prerelease, and explicitly use `latest=false`.
