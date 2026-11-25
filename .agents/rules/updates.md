# Update and Release Builds

## Rule
All application updates and releases must be built locally on this machine (via `cd showcase/tauri && ./build.sh`) and uploaded directly (the bundle files, `.sig` signatures, and generated `latest.json` updater feed) to GitHub Releases and the `updates` branch.

Do not wait for or rely on GitHub Actions cloud runners to build and publish updates. The application must update directly from locally built and uploaded packages.
