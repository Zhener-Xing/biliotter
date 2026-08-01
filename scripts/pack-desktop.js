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

const GUIDE_NAME = 'BiliOtter使用与安装指南.md';

function copyUserGuide(destDir) {
  const src = path.join(root, GUIDE_NAME);
  if (!fs.existsSync(src)) {
    console.warn(`[pack] missing ${GUIDE_NAME}`);
    return null;
  }
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, GUIDE_NAME);
  fs.copyFileSync(src, dest);
  return dest;
}

/** 安装包根目录再放一份扩展 zip + 指南，方便用户直接解压使用 */
function finalizeDistBundle(outDir, resourcesDir) {
  const guideTop = copyUserGuide(outDir);
  if (resourcesDir) copyUserGuide(resourcesDir);

  const bridgeZip = path.join(outRoot, 'bili-pet-bridge.zip');
  if (fs.existsSync(bridgeZip)) {
    fs.copyFileSync(bridgeZip, path.join(outDir, 'bili-pet-bridge.zip'));
  } else {
    console.warn('[pack] bili-pet-bridge.zip missing — run npm run pack:ext first');
  }

  // 简明说明（双击就能看）
  const readmeTxt = path.join(outDir, '请先读我.txt');
  fs.writeFileSync(
    readmeTxt,
    [
      'BiliOtter 安装包',
      '',
      '1. 先打开本文件夹里的「BiliOtter使用与安装指南.md」按步骤安装。',
      '2. 桌宠：Mac 打开 BiliOtter.app；Windows 打开 BiliOtter.exe。',
      '3. 浏览器扩展：解压 bili-pet-bridge.zip，在 Chrome/Edge 开发者模式下「加载已解压的扩展程序」。',
      '4. 打开 bilibili.com 并登录，保持扩展启用。',
      '',
      '详细说明见：BiliOtter使用与安装指南.md',
      '',
    ].join('\n'),
    'utf8'
  );

  return { guideTop, readmeTxt };
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

function applyMacAppIcon(destApp) {
  const icns = path.join(root, 'assets', 'icon.icns');
  if (!fs.existsSync(icns)) {
    console.warn('[pack] assets/icon.icns missing — keeping Electron default icon');
    return;
  }
  const dest = path.join(destApp, 'Contents', 'Resources', 'electron.icns');
  fs.copyFileSync(icns, dest);
  console.log('[pack] applied Mac app icon');
}

function applyWinExeIcon(exePath) {
  const ico = path.join(root, 'assets', 'icon.ico');
  if (!fs.existsSync(ico) || !fs.existsSync(exePath)) {
    console.warn('[pack] Windows icon skipped (missing icon.ico or exe)');
    return;
  }
  // Embedding into .exe needs rcedit; cross-pack from macOS usually lacks Wine.
  if (process.platform !== 'win32') {
    console.warn(
      '[pack] Windows .exe icon not embedded on this host; runtime window icon still uses assets/icon.ico'
    );
    return;
  }
  const r = spawnSync('npx.cmd', ['--yes', 'rcedit', exePath, '--set-icon', ico], {
    stdio: 'inherit',
    shell: true,
  });
  if (r.status === 0) console.log('[pack] applied Windows exe icon');
  else console.warn('[pack] rcedit failed — exe may keep default Electron icon');
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
  applyMacAppIcon(destApp);

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', destApp], {
      stdio: 'inherit',
    });
  } catch (err) {
    console.warn('[pack] codesign failed (app may need right-click Open):', err.message);
  }

  return { destApp, bridge, resources };
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
  applyWinExeIcon(to);

  return { destApp: path.join(outDir, 'BiliOtter.exe'), bridge, resources };
}

function packLinuxFromDist(electronDist, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(electronDist, outDir, { recursive: true });
  const resources = path.join(outDir, 'resources');
  const bridge = injectAppIntoResources(resources);
  const from = path.join(outDir, 'electron');
  const to = path.join(outDir, 'BiliOtter');
  if (fs.existsSync(from)) fs.renameSync(from, to);
  return { destApp: to, bridge, resources };
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
    applyMacAppIcon(destApp);
    result = {
      destApp,
      bridge,
      resources: path.join(destApp, 'Contents', 'Resources'),
    };
  } else {
    throw new Error(`unsupported platform ${platform}`);
  }

  const extras = finalizeDistBundle(outDir, result.resources);
  console.log('Wrote', outDir);
  console.log('  app:', result.destApp);
  console.log('  bridge:', result.bridge);
  if (extras.guideTop) console.log('  guide:', extras.guideTop);
  if (extras.readmeTxt) console.log('  readme:', extras.readmeTxt);

  // 分发包一律打成 zip：Mac / Windows 各一个安装包
  const wantZip = opts.zip || platform === 'win32' || platform === 'darwin';
  if (wantZip) {
    const zipName =
      platform === 'darwin'
        ? `BiliOtter-macOS-${arch}.zip`
        : platform === 'win32'
          ? `BiliOtter-Windows-x64.zip`
          : `BiliOtter-${platform}-${arch}.zip`;
    const zipPath = path.join(outRoot, zipName);
    zipFolder(outDir, zipPath);
    console.log('Wrote', zipPath);
  }
}

main().catch((err) => {
  console.error('[pack] failed:', err.message || err);
  process.exit(1);
});
