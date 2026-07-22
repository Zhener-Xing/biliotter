const statusEl = document.getElementById('status');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');

let busy = false;

function setStatus(message, state = 'idle') {
  statusEl.textContent = message || '未运行';
  statusEl.dataset.state = state;
}

function setBusy(next) {
  busy = next;
  btnStart.disabled = busy;
  btnStop.disabled = busy;
}

async function api(path, method = 'GET') {
  const res = await fetch(path, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? '{}' : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.message || `请求失败 (${res.status})`);
  }
  return data;
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    if (data.running) {
      setStatus(data.message || '运行中', 'running');
    } else {
      setStatus(data.message || '未运行', 'idle');
    }
  } catch (err) {
    setStatus(err.message || '无法连接启动服务', 'error');
  }
}

btnStart.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  setStatus('正在启动…', 'busy');
  try {
    const data = await api('/api/start', 'POST');
    setStatus(data.message || '运行中', 'running');
  } catch (err) {
    setStatus(err.message || '启动失败', 'error');
  } finally {
    setBusy(false);
    refreshStatus();
  }
});

btnStop.addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  setStatus('正在终止…', 'busy');
  try {
    const data = await api('/api/stop', 'POST');
    setStatus(data.message || '已停止', 'idle');
  } catch (err) {
    setStatus(err.message || '终止失败', 'error');
  } finally {
    setBusy(false);
    refreshStatus();
  }
});

refreshStatus();
setInterval(refreshStatus, 4000);
