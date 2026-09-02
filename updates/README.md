# SmoothOps Updates

This folder is a template for the hosted manifest that the app polls.

## How pushing an update works (Windows) — auto version + auto rename

**One-command builds (auto bump + auto rename)** — pick `patch` (`1.2.0→1.2.1`), `minor` (`1.2.0→1.3.0`), `major` (`1.2.0→2.0.0`) per semver:

```bash
# from project root (auto bumps, syncs app.go:wails.json:frontend/package.json:updates/windows/latest.json, builds frontend, builds NSIS, renames)
node scripts/build-windows.mjs --bump patch --notes "fix: faster compression"
node scripts/build-windows.mjs --bump minor --notes "feat: new format"
node scripts/build-windows.mjs --bump major

# or via npm (frontend/):
npm run release:patch -- --notes "fix"
npm run release:minor
npm run release:major
npm run build:windows   # no bump, just build+rename with current version

# manual bump only (no build):
node scripts/bump-version.mjs patch
npm run version:patch
```

What the scripts do (`scripts/bump-version.mjs:1`, `scripts/build-windows.mjs:1`):
- Increment `app.go:AppVersion` + `wails.json:info.productVersion` + `frontend/package.json:version` in sync (patch increments `x.y.Z`, minor `x.Y.0`, major `X.0.0`).
- Bump `updates/windows/latest.json:version/latestVersion/publishedAt` and auto-replace old version in `url` placeholder.
- Frontend build → `wails build -platform windows/amd64 -nsis` → auto-rename `build/bin/*installer.exe` → `SmoothOps-Converter-{version}-windows-amd64-installer.exe`.

Manual alternative:
```bash
npm run build          # frontend
wails build -platform windows/amd64 -nsis
# output: build/bin/SmoothOps Converter - installer.exe
# rename to include version for hosting:
mv "build/bin/SmoothOps Converter-installer.exe" "SmoothOps-Converter-1.3.0-windows-amd64-installer.exe"
```

3. **Host the installer** (GitHub Releases, S3, CDN):
   - Create release `v1.3.0` > upload `SmoothOps-Converter-1.3.0-...exe` > copy download URL.

4. **Update the manifest** that clients poll (`app.go:UpdateManifestURL`):
   ```json
   {
     "version": "1.3.0",
     "url": "https://github.com/YOUR_ORG/smoothops-converter/releases/download/v1.3.0/SmoothOps-Converter-1.3.0-windows-amd64-installer.exe",
     "notes": "Faster compression, bug fixes",
     "mandatory": false,
     "publishedAt": "2026-09-03"
   }
   ```
   Host this at the URL in `app.go:UpdateManifestURL` (e.g. `https://raw.githubusercontent.com/YOUR_ORG/smoothops-converter/main/updates/windows/latest.json` or `https://cdn.yourdomain.com/smoothops/windows/latest.json`). Must be HTTPS + CORS `Access-Control-Allow-Origin: *` if fetched from frontend fallback.

5. **Client behavior** (`app.go:CheckForUpdate`, `frontend/src/main.tsx:82`):
   - On launch + every 6h + manual “Check again”, app `GET`s manifest, `compareVersions(latest, 1.2.0) > 0` → `update-available` event.
   - UI shows amber banner: “Update available: v1.3.0 (you have v1.2.0) — notes” [Update now] [Dismiss] (mandatory hides Dismiss).
   - `Update now` → `DownloadAndInstallUpdate(url)` streams to `%TEMP%/SmoothOps-Update-*.exe` with progress (`job-progress`), then `cmd /c start "" tmp.exe` + `runtime.Quit` . NSIS replaces the old build; user sees UAC, installer, then new version.

6. **Test without publishing**:
   ```bash
   # serve local manifest
   python3 -m http.server 8000 --directory updates/windows
   # temporarily set UpdateManifestURL = "http://localhost:8000/latest.json" and edit latest.json version to 9.9.9
   wails dev  # banner appears
   ```

Set `UpdateManifestURL` in `app.go:12` to your real hosted URL before shipping the installer to clients. Clients on old builds that still point to placeholder will never see updates — ship at least one build with the correct URL.

