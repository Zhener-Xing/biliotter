const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatClose = document.getElementById('chat-close');

/** @type {{role:'user'|'assistant', content:string}[]} */
let chatMessages = [];
let chatBusy = false;

const BV_RE = /BV[\w]+/gi;

function openHomeNote(bvid) {
  const id = String(bvid || '').trim();
  if (!id || !window.biliPet?.goHome) return;
  void window.biliPet.goHome({ bvid: id });
}

/** 把回复里的 BV 号做成可点链接，跳转知识库对应笔记 */
function fillTextWithBvLinks(el, text) {
  const raw = String(text || '');
  BV_RE.lastIndex = 0;
  let last = 0;
  let match;
  let linked = false;
  while ((match = BV_RE.exec(raw))) {
    if (match.index > last) {
      el.appendChild(document.createTextNode(raw.slice(last, match.index)));
    }
    const bvid = match[0];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-bv-link';
    btn.textContent = bvid;
    btn.title = '在知识库中打开这篇笔记';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openHomeNote(bvid);
    });
    el.appendChild(btn);
    linked = true;
    last = match.index + bvid.length;
  }
  if (last < raw.length) {
    el.appendChild(document.createTextNode(raw.slice(last)));
  }
  if (!linked && last === 0) {
    el.textContent = raw;
  }
}

function appendChatMsg(role, text) {
  if (!chatLog || !text) return;
  const el = document.createElement('div');
  el.className = `chat-msg ${role === 'user' ? 'user' : role === 'system' ? 'system' : 'bot'}`;
  if (role === 'assistant' || role === 'bot') {
    fillTextWithBvLinks(el, text);
  } else {
    el.textContent = text;
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeThinking() {
  const thinking = chatLog?.querySelector('.chat-msg.system:last-child');
  if (thinking && thinking.textContent === '思考中…') thinking.remove();
}

async function sendChat() {
  if (chatBusy || !chatInput) return;
  const text = String(chatInput.value || '').trim();
  if (!text) return;

  chatInput.value = '';
  appendChatMsg('user', text);
  chatMessages.push({ role: 'user', content: text });
  chatBusy = true;
  if (chatSend) chatSend.disabled = true;
  appendChatMsg('system', '思考中…');

  try {
    const res = await window.biliPet?.chat?.(chatMessages);
    removeThinking();
    if (!res?.ok) {
      appendChatMsg('system', res?.error || '对话失败，请检查 LLM 配置');
      return;
    }
    const reply = String(res.text || '').trim();
    if (!reply) {
      appendChatMsg('system', '没有收到回复');
      return;
    }
    chatMessages.push({ role: 'assistant', content: reply });
    appendChatMsg('assistant', reply);
  } catch (err) {
    removeThinking();
    appendChatMsg('system', err?.message || String(err));
  } finally {
    chatBusy = false;
    if (chatSend) chatSend.disabled = false;
    chatInput?.focus();
  }
}

chatClose?.addEventListener('click', () => {
  window.biliPet?.closeWindow?.();
});

chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendChat();
});

appendChatMsg('system', '嗨，我是 BiliOtter，有什么想聊的？');
setTimeout(() => chatInput?.focus(), 80);
