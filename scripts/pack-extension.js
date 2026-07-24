'use strict';

/**
 * Zip internet_extension/ → dist/bili-pet-bridge.zip for Chrome/Edge side-load.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const src = path.join(root, 'internet_extension');
const outDir = path.join(root, 'dist');
const outZip = path.join(outDir, 'bili-pet-bridge.zip');

if (!fs.existsSync(src)) {
  console.error('missing internet_extension/');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(outZip)) fs.unlinkSync(outZip);

const r = spawnSync(
  'zip',
  ['-r', '-q', outZip, '.', '-x', '*.DS_Store', '*__MACOSX*'],
  { cwd: src, stdio: 'inherit' }
);

if (r.error || r.status !== 0) {
  console.error(
    r.error?.message ||
      'zip failed — install zip (macOS/Linux) or run from Git Bash on Windows'
  );
  process.exit(r.status || 1);
}

console.log('Wrote', outZip);
