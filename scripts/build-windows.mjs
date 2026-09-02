#!/usr/bin/env node
// One-command: bump semver, build frontend, build Windows NSIS installer, auto-rename with version.
// Usage:
//   node scripts/build-windows.mjs --bump patch --notes "fix: ..." [--no-bump]
//   node scripts/build-windows.mjs --bump minor
//   node scripts/build-windows.mjs --bump major
// If --no-bump, just builds + renames with current version (no increment).
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function sh(cmd, args, opts={}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || root, shell: false });
  if (r.status !== 0) { console.error(`failed: ${cmd} ${args.join(' ')}`); process.exit(r.status || 1); }
}

const argv = process.argv.slice(2);
const bumpIdx = argv.indexOf('--bump');
let bumpKind = null;
if (bumpIdx !== -1) bumpKind = argv[bumpIdx+1];
const noBump = argv.includes('--no-bump');
const notesIdx = argv.indexOf('--notes');
let notes = notesIdx !== -1 ? argv[notesIdx+1] : '';

if (!noBump && bumpKind && !['patch','minor','major'].includes(bumpKind)) {
  console.error('Usage: node scripts/build-windows.mjs --bump <patch|minor|major> [--notes "..."]  OR  --no-bump');
  process.exit(1);
}
if (!noBump && !bumpKind) {
  console.error('Require --bump patch|minor|major  or --no-bump (each build auto-increments semver until you change manually)\nExample: node scripts/build-windows.mjs --bump patch');
  process.exit(1);
}

if (bumpKind && !noBump) {
  sh('node', ['scripts/bump-version.mjs', bumpKind]);
  // allow notes to be written into manifest after bump
  if (notes) {
    const manifestPath = path.join(root, 'updates', 'windows', 'latest.json');
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const m = JSON.parse(raw);
      m.notes = notes;
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
      console.log(`  manifest notes -> ${notes}`);
    } catch {}
  }
}

// read current version after bump
const wails = JSON.parse(fs.readFileSync(path.join(root, 'wails.json'), 'utf8'));
const version = wails.info?.productVersion || '0.0.0';
console.log(`\nBuilding version ${version} ...`);

// 1. frontend build
sh('npm', ['run', 'build'], { cwd: path.join(root, 'frontend') });

// 2. wails build windows nsis (requires wails CLI + nsis on host)
const wailsBin = process.env.WAILS_BIN || '/home/gourav/go/bin/wails';
if (!fs.existsSync(wailsBin)) {
  console.error(`wails binary not found at ${wailsBin}. Set WAILS_BIN or install wails.`);
  process.exit(1);
}
sh(wailsBin, ['build', '-platform', 'windows/amd64', '-nsis']);

// 3. auto-rename installer with version
// wails NSIS outputs: build/bin/SmoothOps Converter - installer.exe  (or similar)
// we rename to SmoothOps-Converter-{version}-windows-amd64-installer.exe
const binDir = path.join(root, 'build', 'bin');
const files = fs.readdirSync(binDir);
const installer = files.find(f => f.toLowerCase().includes('installer') && f.endsWith('.exe'));
if (!installer) {
  console.warn(`No installer exe found in ${binDir}. Files: ${files.join(', ')}`);
  process.exit(0);
}
const src = path.join(binDir, installer);
const dstName = `SmoothOps-Converter-${version}-windows-amd64-installer.exe`;
const dst = path.join(binDir, dstName);
if (src !== dst) {
  fs.renameSync(src, dst);
  console.log(`\nRenamed:\n  ${installer}\n  -> ${dstName}`);
} else {
  console.log(`Already named ${dstName}`);
}

// 4. hint for manifest url
console.log(`
Next push steps (windows):
  1. Upload ${dstName} to GitHub Releases v${version} (or S3)
  2. Edit updates/windows/latest.json url -> actual download URL (currently placeholder)
     url: https://github.com/YOUR_ORG/smoothops-converter/releases/download/v${version}/${dstName}
  3. git add wails.json app.go frontend/package.json updates/windows/latest.json
     git commit -m "release: v${version}"
     git push   # raw.githubusercontent.com manifest becomes live -> clients see banner in ~poll interval
  4. Clients on old builds (with correct UpdateManifestURL) get banner "Update available: v${version}"
     [Update now] downloads ${dstName} to %TEMP% and launches it, old build is replaced.
`);
