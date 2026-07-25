'use strict';

const fs = require('fs');
const path = require('path');

/** App / source root (read-only when packaged). */
const APP_ROOT = __dirname;

/** Writable runtime data (DBs, tokens, .env, notes-assets). */
let dataRoot = APP_ROOT;

function getDataRoot() {
  return dataRoot;
}

function dataPath(...parts) {
  return path.join(dataRoot, ...parts);
}

/**
 * Packaged Electron → userData; `npm start` / scripts → repo root (unchanged).
 * Call once in main before requiring modules that touch disk state.
 *
 * Note: `app.isPackaged` is false for unpacked `Resources/app` (our pack-desktop
 * layout), so also detect that path.
 * @param {import('electron').App} [electronApp]
 */
function initAppPaths(electronApp) {
  let packaged = Boolean(electronApp && electronApp.isPackaged);
  if (!packaged && electronApp && typeof electronApp.getAppPath === 'function') {
    const appPath = String(electronApp.getAppPath() || '').replace(/\\/g, '/');
    packaged =
      /\/Resources\/app\/?$/i.test(appPath) || /\/resources\/app\/?$/i.test(appPath);
  }
  if (packaged && electronApp) {
    dataRoot = electronApp.getPath('userData');
  } else {
    dataRoot = APP_ROOT;
  }
  fs.mkdirSync(dataRoot, { recursive: true });
  return dataRoot;
}

/** Tests / scripts that are not Electron. */
function setDataRoot(dir) {
  dataRoot = path.resolve(String(dir || APP_ROOT));
  fs.mkdirSync(dataRoot, { recursive: true });
  return dataRoot;
}

/** First packaged launch: seed .env from example if missing.
 * Also fill blank CLOUD_API_BASE / CLOUD_DEVICE_SECRET from .env.example. */
function ensureEnvFile() {
  const dest = dataPath('.env');
  const example = path.join(APP_ROOT, '.env.example');
  if (!fs.existsSync(dest)) {
    if (fs.existsSync(example)) {
      try {
        fs.copyFileSync(example, dest);
      } catch (err) {
        console.warn('[bili-pet] seed .env failed:', err?.message || err);
      }
    }
    return dest;
  }

  try {
    if (!fs.existsSync(example)) return dest;
    const exampleText = fs.readFileSync(example, 'utf8');
    let text = fs.readFileSync(dest, 'utf8');
    let changed = false;

    const fillBlank = (key) => {
      const mEx = exampleText.match(new RegExp(`^${key}=(.*)$`, 'm'));
      const shared = String(mEx?.[1] || '')
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (!shared) return;
      const mCur = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
      const cur = String(mCur?.[1] || '')
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (cur) return;
      if (mCur) {
        text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${shared}`);
      } else {
        text = `${text.replace(/\s*$/, '')}\n${key}=${shared}\n`;
      }
      changed = true;
      console.log(`[bili-pet] filled empty ${key}`);
    };

    fillBlank('CLOUD_API_BASE');
    fillBlank('CLOUD_DEVICE_SECRET');

    if (changed) fs.writeFileSync(dest, text, 'utf8');
  } catch (err) {
    console.warn('[bili-pet] merge .env defaults failed:', err?.message || err);
  }
  return dest;
}

module.exports = {
  APP_ROOT,
  getDataRoot,
  dataPath,
  initAppPaths,
  setDataRoot,
  ensureEnvFile,
};
