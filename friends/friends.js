const statusEl = document.getElementById('friends-status');
const invitePin = document.getElementById('invite-pin');
const inviteTtl = document.getElementById('invite-ttl');
const inviteCreate = document.getElementById('invite-create');
const inviteCancel = document.getElementById('invite-cancel');
const inviteMeta = document.getElementById('invite-meta');
const joinPin = document.getElementById('join-pin');
const joinSubmit = document.getElementById('join-submit');
const friendsList = document.getElementById('friends-list');
const friendsEmpty = document.getElementById('friends-empty');
const friendsRefresh = document.getElementById('friends-refresh');
const friendsClose = document.getElementById('friends-close');
const noteInboxList = document.getElementById('note-inbox-list');
const noteInboxEmpty = document.getElementById('note-inbox-empty');

function showStatus(text, tone = '') {
  if (!statusEl) return;
  const msg = String(text || '').trim();
  if (!msg) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.dataset.tone = tone;
}

function digitsOnly(el) {
  el?.addEventListener('input', () => {
    el.value = String(el.value || '')
      .replace(/\D/g, '')
      .slice(0, 4);
  });
}

digitsOnly(invitePin);
digitsOnly(joinPin);

function formatRemain(expiresAt) {
  const ms = Math.max(0, Number(expiresAt) - Date.now());
  const sec = Math.ceil(ms / 1000);
  if (sec <= 0) return '已过期';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function errText(res) {
  const code = res?.error || 'error';
  const map = {
    cloud_disabled: '未配置云端，无法使用好友功能',
    no_token: '云端尚未鉴权成功，请保持 B 站打开并稍等几秒再试',
    waiting_cookie: '请打开已登录的 bilibili.com，或配置 CLOUD_DEVICE_SECRET 走自建鉴权',
    waiting_cloud_auth: '云端鉴权未完成，请稍后再试（或检查 CLOUD_DEVICE_SECRET 是否与服务器一致）',
    device_auth_disabled: '未配置自建鉴权密钥',
    invalid_device_secret: '自建鉴权密钥不匹配',
    auth_failed: '云端鉴权失败，请检查密钥或稍后重试',
    invalid_pin: '请输入 4 位数字密钥',
    pin_taken: '这个密钥正被占用，换一组数字',
    invite_not_found: '密钥无效或已过期',
    cannot_friend_self: '不能添加自己',
    not_friends: '还不是好友',
    cooldown: '摸獭太勤了，请隔 5 分钟再摸',
    cannot_pet_self: '不能摸自己的獭',
    missing_uid: '缺少好友信息',
    not_bound: '请先登录并同步知识库',
    already_sent: '这篇笔记已经传给过对方，不能再发',
    empty_note: '笔记是空的，写点内容再传',
    note_not_found: '找不到这篇笔记',
    note_too_large: '笔记太大，传不过去',
    cannot_share_self: '不能传给自己',
    share_not_found: '这条分享不存在或已处理',
    already_resolved: '已经处理过了',
    share_expired: '分享已过期',
    save_failed: '接收失败，本地保存出错',
  };
  if (code === 'cooldown' && res.retryAfterMs) {
    const sec = Math.ceil(Number(res.retryAfterMs) / 1000);
    return `摸獭冷却中，约 ${sec} 秒后再试`;
  }
  return map[code] || res?.message || `失败：${code}`;
}

async function refreshInvite() {
  const res = await window.biliPet?.friendsGetInvite?.();
  if (!res?.ok) {
    inviteMeta.textContent = '';
    inviteCancel.hidden = true;
    return;
  }
  const invite = res.invite;
  if (!invite) {
    inviteMeta.textContent = '当前没有有效密钥';
    inviteCancel.hidden = true;
    return;
  }
  invitePin.value = String(invite.pin || '');
  inviteMeta.textContent = `密钥 ${invite.pin} · 剩余 ${formatRemain(invite.expiresAt)}`;
  inviteCancel.hidden = false;
}

function renderFriends(friends) {
  friendsList.innerHTML = '';
  const list = Array.isArray(friends) ? friends : [];
  friendsEmpty.hidden = list.length > 0;
  for (const f of list) {
    const li = document.createElement('li');
    li.className = 'friend-card';
    const online = Boolean(f.online);
    li.innerHTML = `
      <div class="friend-info">
        <div class="friend-name"></div>
        <div class="friend-online ${online ? '' : 'is-off'}"></div>
      </div>
      <div class="friend-actions">
        <button type="button" class="friends-btn pet-btn">摸TA的獭</button>
        <button type="button" class="friends-btn friends-btn-ghost rm-btn">删除好友</button>
      </div>
    `;
    li.querySelector('.friend-name').textContent = f.uname || `UID ${f.uid}`;
    li.querySelector('.friend-online').textContent = online ? '在线' : '离线（会留言）';
    li.querySelector('.pet-btn').addEventListener('click', async () => {
      const r = await window.biliPet?.friendsPet?.(f.uid);
      if (r?.ok) {
        showStatus(
          r.delivered === 'live' ? `已摸「${f.uname}」的獭` : `「${f.uname}」不在线，已留言等TA上线`,
          'ok'
        );
      } else {
        showStatus(errText(r), 'error');
      }
    });
    li.querySelector('.rm-btn').addEventListener('click', async () => {
      const name = f.uname || `UID ${f.uid}`;
      if (!window.confirm(`确定删除好友「${name}」？`)) return;
      const r = await window.biliPet?.friendsRemove?.(f.uid);
      if (r?.ok) {
        showStatus(`已删除好友「${name}」`, 'ok');
        await refreshFriends();
      } else {
        showStatus(errText(r), 'error');
      }
    });
    friendsList.appendChild(li);
  }
}

function renderNoteInbox(shares) {
  if (!noteInboxList) return;
  noteInboxList.innerHTML = '';
  const list = Array.isArray(shares) ? shares : [];
  if (noteInboxEmpty) noteInboxEmpty.hidden = list.length > 0;
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'friend-card';
    li.innerHTML = `
      <div class="friend-info">
        <div class="friend-name"></div>
        <div class="friend-online"></div>
      </div>
      <div class="friend-actions">
        <button type="button" class="friends-btn accept-btn">接收</button>
        <button type="button" class="friends-btn friends-btn-ghost reject-btn">不接收</button>
      </div>
    `;
    const title = s.title || s.bvid || '笔记';
    li.querySelector('.friend-name').textContent = title;
    li.querySelector('.friend-online').textContent = `来自 ${s.fromUname || s.fromUid}`;
    li.querySelector('.accept-btn').addEventListener('click', async () => {
      const r = await window.biliPet?.friendsNoteAccept?.(s.id);
      if (r?.ok) {
        const tip = r.renamed
          ? `已接收「${r.title}」（本地已有同 BV，另存为副本）`
          : `已接收笔记「${r.title}」`;
        showStatus(tip, 'ok');
        await refreshNoteInbox();
      } else {
        showStatus(errText(r), 'error');
      }
    });
    li.querySelector('.reject-btn').addEventListener('click', async () => {
      if (!window.confirm(`确定不接收「${title}」？`)) return;
      const r = await window.biliPet?.friendsNoteReject?.(s.id);
      if (r?.ok) {
        showStatus(`已拒绝「${title}」`, 'ok');
        await refreshNoteInbox();
      } else {
        showStatus(errText(r), 'error');
      }
    });
    noteInboxList.appendChild(li);
  }
}

async function refreshFriends() {
  const res = await window.biliPet?.friendsList?.();
  if (!res?.ok) {
    showStatus(errText(res), 'error');
    renderFriends([]);
    return;
  }
  renderFriends(res.friends || []);
}

async function refreshNoteInbox() {
  const res = await window.biliPet?.friendsNoteInbox?.();
  if (!res?.ok) {
    renderNoteInbox([]);
    return;
  }
  renderNoteInbox(res.shares || []);
}

inviteCreate?.addEventListener('click', async () => {
  const pin = String(invitePin.value || '').trim();
  const ttlMs = Number(inviteTtl.value) || 300000;
  const res = await window.biliPet?.friendsCreateInvite?.(pin, ttlMs);
  if (res?.ok) {
    showStatus(`密钥已生成：${res.pin}`, 'ok');
    await refreshInvite();
  } else {
    showStatus(errText(res), 'error');
  }
});

inviteCancel?.addEventListener('click', async () => {
  const res = await window.biliPet?.friendsCancelInvite?.();
  if (res?.ok) {
    showStatus('已取消密钥', 'ok');
    invitePin.value = '';
    await refreshInvite();
  } else {
    showStatus(errText(res), 'error');
  }
});

joinSubmit?.addEventListener('click', async () => {
  const pin = String(joinPin.value || '').trim();
  const res = await window.biliPet?.friendsJoin?.(pin);
  if (res?.ok) {
    const name = res.friend?.uname || res.friend?.uid || '';
    showStatus(res.alreadyFriends ? `你们已是好友：${name}` : `已加好友：${name}`, 'ok');
    joinPin.value = '';
    await refreshFriends();
  } else {
    showStatus(errText(res), 'error');
  }
});

friendsRefresh?.addEventListener('click', () => {
  void refreshFriends();
  void refreshInvite();
  void refreshNoteInbox();
});

friendsClose?.addEventListener('click', () => {
  window.biliPet?.closeWindow?.();
});

void (async () => {
  await refreshInvite();
  await refreshFriends();
  await refreshNoteInbox();
})();

setInterval(() => {
  void refreshInvite();
  void refreshNoteInbox();
}, 15_000);
