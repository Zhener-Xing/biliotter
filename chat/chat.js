const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatClose = document.getElementById('chat-close');

/** @type {{role:'user'|'assistant', content:string}[]} */
let chatMessages = [];
let chatBusy = false;

function appendChatMsg(role, text) {
  if (!chatLog || !text) return;
  const el = document.createElement('div');
  el.className = `chat-msg ${role === 'user' ? 'user' : role === 'system' ? 'system' : 'bot'}`;
  el.textContent = text;
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
