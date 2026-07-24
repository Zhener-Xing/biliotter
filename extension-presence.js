'use strict';

/** Keep wider than heartbeat alarm; Chrome may delay SW alarms when idle. */
const EXTENSION_ALIVE_MS = 90_000;

let lastSeenAt = 0;
let wasAlive = false;

/** @type {null | ((event: { alive: boolean, lastSeenAt: number }) => void)} */
let onPresenceChange = null;

function setPresenceChangeHandler(fn) {
  onPresenceChange = typeof fn === 'function' ? fn : null;
}

function touchExtensionPresence(at = Date.now()) {
  const prev = wasAlive;
  lastSeenAt = Number(at) || Date.now();
  wasAlive = true;
  if (!prev) {
    try {
      onPresenceChange?.({ alive: true, lastSeenAt });
    } catch (_) {
      /* ignore */
    }
  }
  return lastSeenAt;
}

function isExtensionAlive(now = Date.now()) {
  return lastSeenAt > 0 && now - lastSeenAt < EXTENSION_ALIVE_MS;
}

function getExtensionLastSeenAt() {
  return lastSeenAt;
}

/** Call periodically; emits offline once when crossing the timeout. */
function pollExtensionPresence(now = Date.now()) {
  const alive = isExtensionAlive(now);
  if (wasAlive && !alive) {
    wasAlive = false;
    try {
      onPresenceChange?.({ alive: false, lastSeenAt });
    } catch (_) {
      /* ignore */
    }
  }
  return alive;
}

module.exports = {
  EXTENSION_ALIVE_MS,
  touchExtensionPresence,
  isExtensionAlive,
  getExtensionLastSeenAt,
  pollExtensionPresence,
  setPresenceChangeHandler,
};
