'use strict';
process.env.BILI_PET_SKIP_LEGACY_MIGRATE = '1';

const fs = require('fs');
const {
  setActiveUid,
  getActiveUid,
  saveNoteDoc,
  loadNoteDoc,
  clearAllPending,
  buildPendingPushPayload,
  applyRemoteChanges,
  closeNotesDb,
  dbPathForUid,
  hasPendingSync,
  purgeUidLocalStore,
} = require('../notes-db');
const {
  handleAccountPayload,
  saveAccount,
  loadAccount,
  clearBinding,
  commitBinding,
} = require('../account-bind');

const uidA = '100001';
const uidB = '100002';

function cleanup() {
  for (const uid of [uidA, uidB]) {
    const f = dbPathForUid(uid);
    for (const p of [f, `${f}-wal`, `${f}-shm`]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

cleanup();
saveAccount({
  activeUid: null,
  boundUid: null,
  sessionLoggedIn: false,
  lastSeenUid: null,
});

let gate = handleAccountPayload({
  kind: 'account_hello',
  account: { uid: uidA, loggedIn: true },
  ts: Date.now(),
});
assert(gate.status === 'auto_bound', `expected auto_bound got ${gate.status}`);
setActiveUid(uidA);
saveNoteDoc('BVverifyAAA1', {
  title: 'A note',
  bodyMd: '# A\n',
  notes: { title: 'A note', cues: [], notes: ['a'], summary: '' },
});
assert(loadNoteDoc('BVverifyAAA1')?.title === 'A note', 'A note missing');
assert(hasPendingSync(), 'pending expected for A');

gate = handleAccountPayload({
  kind: 'account_login',
  account: { uid: uidB, loggedIn: true },
  ts: Date.now(),
});
assert(gate.status === 'switched', `expected switched got ${gate.status}`);
assert(gate.prevUid === uidA, 'prevUid should be A');
// Switch is detected but activeUid must stay on A until purge+commit
assert(gate.account.activeUid === uidA, 'activeUid must remain A until commitBinding');

setActiveUid(uidB);
assert(!loadNoteDoc('BVverifyAAA1'), 'B should not see A note');
saveNoteDoc('BVverifyBBB1', {
  title: 'B note',
  bodyMd: '# B\n',
  notes: { title: 'B note', cues: [], notes: ['b'], summary: '' },
});

setActiveUid(uidA);
assert(loadNoteDoc('BVverifyAAA1')?.title === 'A note', 'A note should persist after switch back');
assert(!loadNoteDoc('BVverifyBBB1'), 'A should not see B note');

const payload = buildPendingPushPayload();
assert(Array.isArray(payload.changes.notes), 'push payload notes');

applyRemoteChanges({
  notes: [
    {
      bvid: 'BVverifyRemote1',
      title: 'Remote',
      body_md: '# R\n',
      notes_json: JSON.stringify({
        title: 'Remote',
        cues: [],
        notes: ['r'],
        summary: '',
      }),
      updated_at: Date.now(),
      created_at: Date.now(),
      mode: 'user',
      revision: 1,
    },
  ],
});
assert(loadNoteDoc('BVverifyRemote1')?.title === 'Remote', 'remote apply failed');

// purge: clear pending then delete local store
clearAllPending();
assert(!hasPendingSync(), 'pending should be empty before purge');
const dbFile = dbPathForUid(uidA);
assert(fs.existsSync(dbFile), 'A db should exist before purge');
const purged = purgeUidLocalStore(uidA);
assert(purged.ok, `purge failed: ${purged.error}`);
assert(!fs.existsSync(dbFile), 'A db should be deleted after purge');
assert(getActiveUid() == null, 'activeUid cleared after purge of active store');
clearBinding();
assert(loadAccount().activeUid == null, 'binding cleared');

commitBinding(uidB);
setActiveUid(uidB);
assert(loadNoteDoc('BVverifyBBB1')?.title === 'B note', 'B note should still exist');

closeNotesDb();
cleanup();

saveAccount({
  activeUid: null,
  boundUid: null,
  sessionLoggedIn: false,
  lastSeenUid: null,
});

console.log('[verify-sync-local] OK');
