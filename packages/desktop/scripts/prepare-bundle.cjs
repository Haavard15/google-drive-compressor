'use strict';

const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const apiDistDir = path.join(repoRoot, 'packages', 'api', 'dist');
const webRoot = path.join(repoRoot, 'packages', 'web');
const webStandaloneDir = path.join(webRoot, '.next', 'standalone');
const webStaticDir = path.join(webRoot, '.next', 'static');
const webPublicDir = path.join(webRoot, 'public');
const releaseRoot = path.join(desktopRoot, '.release');

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found at ${targetPath}. Build the package first.`);
  }
}

function ensureCleanDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyDir(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function findFile(rootDir, fileName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }
  return null;
}

function main() {
  assertExists(apiDistDir, 'API build output');
  assertExists(webStandaloneDir, 'Next standalone output');
  assertExists(webStaticDir, 'Next static assets');

  ensureCleanDir(releaseRoot);

  const bundledApiDir = path.join(releaseRoot, 'api');
  const bundledWebDir = path.join(releaseRoot, 'web');

  copyDir(apiDistDir, bundledApiDir);
  copyDir(webStandaloneDir, bundledWebDir);

  const preferredWebEntry = path.join(bundledWebDir, 'packages', 'web', 'server.js');
  const webServerEntry = fs.existsSync(preferredWebEntry)
    ? preferredWebEntry
    : findFile(bundledWebDir, 'server.js');
  if (!webServerEntry) {
    throw new Error('Could not locate Next standalone server.js entrypoint');
  }

  const webServerDir = path.dirname(webServerEntry);
  const bundledStaticDir = path.join(webServerDir, '.next', 'static');
  fs.mkdirSync(path.dirname(bundledStaticDir), { recursive: true });
  copyDir(webStaticDir, bundledStaticDir);

  if (fs.existsSync(webPublicDir)) {
    copyDir(webPublicDir, path.join(webServerDir, 'public'));
  }

  const manifest = {
    apiEntry: path.relative(releaseRoot, path.join(bundledApiDir, 'index.js')),
    webEntry: path.relative(releaseRoot, webServerEntry),
  };

  fs.writeFileSync(
    path.join(releaseRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  console.log('[desktop] Prepared release bundle:', manifest);
}

main();
