'use strict';

/** Cross-platform `electron .` with ELECTRON_RUN_AS_NODE cleared (Cursor sets it). */
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env,
  cwd: require('path').join(__dirname, '..'),
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code || 0);
});
