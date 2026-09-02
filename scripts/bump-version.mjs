#!/usr/bin/env node
// Bump semver across app.go (AppVersion), wails.json (info.productVersion), frontend/package.json (version)
// Usage: node scripts/bump-version.mjs [patch|minor|major|version]  e.g. patch -> 1.2.0 -> 1.2.1
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname ? path.dirname(new URL(import.meta.url).pathname) : process.cwd(), '..');
const wailsPath = path.join(root, 'wails.json');
const appPath = path.join(root, 'app.go');
const frontendPkgPath = path.join(root, 'frontend', 'package.json');
const manifestPath = path.join(root, 'updates', 'windows', 'latest.json');

function parseArgs() {
  const arg = process.argv[2];
  if (!arg || !['patch','minor','major'].includes(arg)) {
    console.error('Usage: node scripts/bump-version.mjs <patch|minor|major>  (e.g. patch: 1.2.0 -> 1.2.1)');
    process.exit(1);
  }
  return arg;
}

function parseVersion(v) {
  v = v.trim().replace(/^v/, '');
  const parts = v.split('.').map(n => parseInt(n, 10));
  return { major: parts[0]||0, minor: parts[1]||0, patch: parts[2]||0 };
}
function bump(v, kind) {
  const p = parseVersion(v);
  if (kind === 'patch') p.patch += 1;
  else if (kind === 'minor') { p.minor += 1; p.patch = 0; }
  else if (kind === 'major') { p.major += 1; p.minor = 0; p.patch = 0; }
  return `${p.major}.${p.minor}.${p.patch}`;
}

const kind = parseArgs();

// source of truth: wails.json productVersion (sync with app.go AppVersion)
const wailsRaw = fs.readFileSync(wailsPath, 'utf8');
const wails = JSON.parse(wailsRaw);
const current = wails.info?.productVersion || '1.2.0';
const next = bump(current, kind);

console.log(`Bumping ${kind}: ${current} -> ${next}`);

// 1. wails.json
wails.info.productVersion = next;
fs.writeFileSync(wailsPath, JSON.stringify(wails, null, 2) + '\n');
console.log(`  updated wails.json productVersion -> ${next}`);

// 2. app.go  const AppVersion = "x.y.z"
let appRaw = fs.readFileSync(appPath, 'utf8');
if (!appRaw.includes('const AppVersion =')) {
  console.error('AppVersion constant not found in app.go');
  process.exit(1);
}
appRaw = appRaw.replace(/const AppVersion = ".*?"/, `const AppVersion = "${next}"`);
fs.writeFileSync(appPath, appRaw);
console.log(`  updated app.go AppVersion -> ${next}`);

// 3. frontend/package.json (keep in sync for npm versioning; create if missing)
try {
  const pkgRaw = fs.readFileSync(frontendPkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  pkg.version = next;
  fs.writeFileSync(frontendPkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  updated frontend/package.json version -> ${next}`);
} catch (e) {
  console.warn(`  skip frontend/package.json: ${e.message}`);
}

// 4. updates/windows/latest.json (template — set version, keep URL placeholder for you to fill after upload)
try {
  if (fs.existsSync(manifestPath)) {
    const mRaw = fs.readFileSync(manifestPath, 'utf8');
    const m = JSON.parse(mRaw);
    m.version = next;
    m.latestVersion = next;
    // do NOT overwrite url automatically — leave YOUR_ORG placeholder until you upload
    // but if url contains old version string, hint to update
    if (m.url && m.url.includes(current)) {
      m.url = m.url.split(current).join(next);
      console.log(`  updated manifest url version placeholder -> ${m.url} (verify!)`);
    }
    m.publishedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    console.log(`  updated updates/windows/latest.json -> ${next}`);
  }
} catch (e) {
  console.warn(`  skip manifest: ${e.message}`);
}

console.log(`Done. Next: npm run build + wails build -platform windows/amd64 -nsis  (or: node scripts/build-windows.mjs --bump ${kind})`);
