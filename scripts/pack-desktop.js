'use strict';

/**
 * Package desktop pet from the already-installed electron binary (no download).
 * Output: dist/BiliOtter-<platform>-<arch>/
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const outRoot = path.join(root, 'dist');
const platform = process.platform;
const arch = process.arch;
const outDir = path.join(outRoot, `BiliOtter-${platform}-${arch}`);

const SKIP_TOP = new Set([
  'dist',
  'cloud-api',
  '.venv',
  '.cursor',
  '.git',
  'notes-assets',
  'node_modules',
]);

function electronBinaryPath() {
  // eslint-disable-next-line import/no-extraneous-dependencies
  return require('electron');
}

/** Preserve relative symlinks inside Electron.app (fs.cpSync rewrites them to abs paths). */
function copyAppBundle(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (process.platform === 'darwin') {
    execFileSync('ditto', [src, dest], { stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    execFileSync('xcopy', [src, dest, '/E', '/I', '/H', '/Y', '/Q'], {
      stdio: 'inherit',
      shell: true,
    });
  } else {
    execFileSync('cp', ['-a', src, dest], { stdio: 'inherit' });
  }
}

function copyFiltered(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === '.DS_Store') continue;
      if (name.startsWith('.bili-pet-')) continue;
      if (/\.db(-wal|-shm)?$/i.test(name)) continue;
      if (name === '.env' || name === '.env.local') continue;
      copyFiltered(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  fs.copyFileSync(src, dest);
}

function copyAppSources(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    if (SKIP_TOP.has(name)) continue;
    if (name === '.DS_Store') continue;
    if (name.startsWith('.bili-pet-')) continue;
    if (/\.db(-wal|-shm)?$/i.test(name)) continue;
    if (name === '.env' || name === '.env.local') continue;
    copyFiltered(path.join(root, name), path.join(appDir, name));
  }
  // Minimal package.json for Electron entry
  const pkg = {
    name: 'BiliOtter',
    productName: 'BiliOtter',
    version: require(path.join(root, 'package.json')).version,
    main: 'canva.js',
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

function copyBridge(resourcesDir) {
  const dest = path.join(resourcesDir, 'bili-pet-bridge');
  fs.cpSync(path.join(root, 'internet_extension'), dest, {
    recursive: true,
    filter: (p) => !p.includes('.DS_Store'),
  });
  const example = path.join(root, '.env.example');
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, path.join(resourcesDir, 'env.example.txt'));
  }
  return dest;
}

function packMac() {
  const bin = electronBinaryPath();
  const electronApp = path.resolve(bin, '..', '..', '..'); // Electron.app
  if (!electronApp.endsWith('.app') || !fs.existsSync(electronApp)) {
    throw new Error(`Electron.app not found near ${bin}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const destApp = path.join(outDir, 'BiliOtter.app');
  copyAppBundle(electronApp, destApp);

  // Rename binary display name is optional; keep Electron executable.
  const resources = path.join(destApp, 'Contents', 'Resources');
  // Prefer our app/ over Electron's default_app.asar
  try {
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  } catch {
    /* ignore */
  }
  const appDir = path.join(resources, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  copyAppSources(appDir);
  const bridge = copyBridge(resources);

  // Ad-hoc sign so Gatekeeper allows local run after we inject Resources/app.
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', destApp], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn('[pack] codesign failed (app may need right-click Open):', err.message);
  }

  return { destApp, bridge };
}

function packWinOrLinux() {
  const bin = electronBinaryPath();
  const distDir = path.dirname(bin);
  if (!fs.existsSync(distDir)) {
    throw new Error(`Electron dist not found: ${distDir}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  copyAppBundle(distDir, outDir);

  const resources = path.join(outDir, 'resources');
  try {
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  } catch {
    /* ignore */
  }
  const appDir = path.join(resources, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  copyAppSources(appDir);
  const bridge = copyBridge(resources);

  const exeName = platform === 'win32' ? 'BiliOtter.exe' : 'BiliOtter';
  const electronExe = platform === 'win32' ? 'electron.exe' : 'electron';
  const from = path.join(outDir, electronExe);
  const to = path.join(outDir, exeName);
  if (fs.existsSync(from) && !fs.existsSync(to)) {
    fs.renameSync(from, to);
  }

  return { destApp: outDir, bridge };
}

function main() {
  if (!fs.existsSync(path.join(root, 'node_modules', 'electron'))) {
    console.error('Run npm install first (needs electron).');
    process.exit(1);
  }

  const result = platform === 'darwin' ? packMac() : packWinOrLinux();
  console.log('Wrote', outDir);
  console.log('  app:', result.destApp);
  console.log('  bridge:', result.bridge);
  console.log('\nTip: zip the folder to share, e.g.');
  console.log(`  cd dist && zip -r BiliOtter-${platform}-${arch}.zip BiliOtter-${platform}-${arch}`);
}

main();
