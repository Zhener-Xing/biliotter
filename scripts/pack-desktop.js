'use strict';

/**
 * Package BiliOtter desktop app.
 *
 *   node scripts/pack-desktop.js                  # current OS
 *   node scripts/pack-desktop.js --win            # Windows x64 zip (cross-pack from Mac/Linux)
 *   node scripts/pack-desktop.js --platform=win32 --arch=x64 --zip
 */
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const outRoot = path.join(root, 'dist');
const cacheRoot = path.join(outRoot, '.electron-cache');

const SKIP_TOP = new Set([
  'dist',
  'cloud-api',
  '.venv',
  '.cursor',
  '.git',
  'notes-assets',
  'node_modules',
]);

function parseArgs(argv) {
  const out = {
    platform: process.platform,
    arch: process.arch,
    zip: false,
  };
  for (const raw of argv) {
    if (raw === '--win' || raw === '--windows') {
      out.platform = 'win32';
      out.arch = 'x64';
      out.zip = true;
      continue;
    }
    if (raw === '--zip') {
      out.zip = true;
      continue;
    }
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    if (m[1] === 'platform') out.platform = m[2];
    if (m[1] === 'arch') out.arch = m[2];
  }
  if (out.platform === 'win32' && !out.arch) out.arch = 'x64';
  return out;
}

function electronVersion() {
  return require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
}

function electronBinaryPath() {
  return require('electron');
}

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

function injectAppIntoResources(resourcesDir) {
  try {
    fs.rmSync(path.join(resourcesDir, 'default_app.asar'), { force: true });
  } catch {
    /* ignore */
  }
  const appDir = path.join(resourcesDir, 'app');
  fs.rmSync(appDir, { recursive: true, force: true });
  copyAppSources(appDir);
  return copyBridge(resourcesDir);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    const file = fs.createWriteStream(tmp);

    const get = (u, redirects = 0) => {
      if (redirects > 8) {
        reject(new Error('too many redirects'));
        return;
      }
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, { headers: { 'User-Agent': 'bili-pet-pack' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`download failed ${res.statusCode} ${u}`));
          res.resume();
          return;
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        let lastPct = -1;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (!total) return;
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            process.stdout.write(`\r[pack] download ${pct}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (total) process.stdout.write('\r[pack] download 100%\n');
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
      });
      req.on('error', (err) => {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        reject(err);
      });
    };

    get(url);
  });
}

function electronZipUrl(version, platform, arch) {
  const mirror = String(process.env.ELECTRON_MIRROR || '')
    .trim()
    .replace(/\/+$/, '');
  const file = `electron-v${version}-${platform}-${arch}.zip`;
  if (mirror) {
    // e.g. https://npmmirror.com/mirrors/electron/
    return `${mirror}/v${version}/${file}`;
  }
  return `https://github.com/electron/electron/releases/download/v${version}/${file}`;
}

async function ensureElectronDist(platform, arch) {
  const version = electronVersion();
  const label = `${platform}-${arch}`;
  const zipPath = path.join(cacheRoot, `electron-v${version}-${label}.zip`);
  const extractDir = path.join(cacheRoot, `electron-v${version}-${label}`);

  if (!fs.existsSync(path.join(extractDir, platform === 'darwin' ? 'Electron.app' : platform === 'win32' ? 'electron.exe' : 'electron'))) {
    if (!fs.existsSync(zipPath)) {
      const url = electronZipUrl(version, platform, arch);
      console.log(`[pack] downloading Electron ${version} (${label})`);
      console.log(`[pack] ${url}`);
      await downloadFile(url, zipPath);
    } else {
      console.log(`[pack] using cached zip ${zipPath}`);
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    console.log('[pack] extracting…');
    const r = spawnSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], {
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      throw new Error('unzip failed — need `unzip` on PATH');
    }
  } else {
    console.log(`[pack] using cached Electron ${extractDir}`);
  }
  return extractDir;
}

function zipFolder(folderPath, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const parent = path.dirname(folderPath);
  const base = path.basename(folderPath);
  const r = spawnSync('zip', ['-r', '-q', zipPath, base], {
    cwd: parent,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error('zip failed — need `zip` on PATH');
  }
  return zipPath;
}

function packMacFromLocal(outDir) {
  const bin = electronBinaryPath();
  const electronApp = path.resolve(bin, '..', '..', '..');
  if (!electronApp.endsWith('.app') || !fs.existsSync(electronApp)) {
    throw new Error(`Electron.app not found near ${bin}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const destApp = path.join(outDir, 'BiliOtter.app');
  copyAppBundle(electronApp, destApp);
  const resources = path.join(destApp, 'Contents', 'Resources');
  const bridge = injectAppIntoResources(resources);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', destApp], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn('[pack] codesign failed (app may need right-click Open):', err.message);
  }

  return { destApp, bridge };
}

function packWinFromDist(electronDist, outDir) {
  const exeSrc = path.join(electronDist, 'electron.exe');
  if (!fs.existsSync(exeSrc)) {
    throw new Error(`electron.exe not found in ${electronDist}`);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Copy all Electron win files into output folder
  for (const name of fs.readdirSync(electronDist)) {
    if (name === 'version' || name === 'LICENSE' || name === 'LICENSES.chromium.html') {
      // keep for compliance
    }
    const from = path.join(electronDist, name);
    const to = path.join(outDir, name);
    fs.cpSync(from, to, { recursive: true });
  }

  const resources = path.join(outDir, 'resources');
  const bridge = injectAppIntoResources(resources);

  const from = path.join(outDir, 'electron.exe');
  const to = path.join(outDir, 'BiliOtter.exe');
  if (fs.existsSync(from)) fs.renameSync(from, to);

  return { destApp: path.join(outDir, 'BiliOtter.exe'), bridge };
}

function packLinuxFromDist(electronDist, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(electronDist, outDir, { recursive: true });
  const resources = path.join(outDir, 'resources');
  const bridge = injectAppIntoResources(resources);
  const from = path.join(outDir, 'electron');
  const to = path.join(outDir, 'BiliOtter');
  if (fs.existsSync(from)) fs.renameSync(from, to);
  return { destApp: to, bridge };
}

async function main() {
  if (!fs.existsSync(path.join(root, 'node_modules', 'electron'))) {
    console.error('Run npm install first (needs electron).');
    process.exit(1);
  }

  const opts = parseArgs(process.argv.slice(2));
  const { platform, arch } = opts;
  const outDir = path.join(outRoot, `BiliOtter-${platform}-${arch}`);
  fs.mkdirSync(outRoot, { recursive: true });

  let result;
  const sameHost = platform === process.platform && arch === process.arch;

  if (platform === 'darwin' && sameHost) {
    result = packMacFromLocal(outDir);
  } else if (platform === 'win32') {
    const dist = await ensureElectronDist('win32', arch);
    result = packWinFromDist(dist, outDir);
  } else if (platform === 'linux') {
    const dist = sameHost
      ? path.dirname(electronBinaryPath())
      : await ensureElectronDist('linux', arch);
    result = packLinuxFromDist(dist, outDir);
  } else if (platform === 'darwin') {
    const dist = await ensureElectronDist('darwin', arch);
    // dist contains Electron.app
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const destApp = path.join(outDir, 'BiliOtter.app');
    copyAppBundle(path.join(dist, 'Electron.app'), destApp);
    const bridge = injectAppIntoResources(path.join(destApp, 'Contents', 'Resources'));
    result = { destApp, bridge };
  } else {
    throw new Error(`unsupported platform ${platform}`);
  }

  console.log('Wrote', outDir);
  console.log('  app:', result.destApp);
  console.log('  bridge:', result.bridge);

  const wantZip = opts.zip || platform === 'win32';
  if (wantZip) {
    const zipPath = path.join(outRoot, `BiliOtter-${platform}-${arch}.zip`);
    zipFolder(outDir, zipPath);
    console.log('Wrote', zipPath);
  }
}

main().catch((err) => {
  console.error('[pack] failed:', err.message || err);
  process.exit(1);
});
