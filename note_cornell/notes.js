document.getElementById('notes-close')?.addEventListener('click', () => {
  flushSaveSync();
  window.biliPet?.closeWindow?.();
});

const headingEl = document.getElementById('notes-heading');
const statusEl = document.getElementById('notes-status');
const editorEl = document.getElementById('notes-editor');
const previewEl = document.getElementById('notes-preview');
const sheetEl = document.getElementById('notes-sheet');
const organizeBtn = document.getElementById('notes-organize');
const shareBtn = document.getElementById('notes-share');
const sharePanel = document.getElementById('notes-share-panel');
const shareList = document.getElementById('notes-share-list');
const shareEmpty = document.getElementById('notes-share-empty');
const shareCancel = document.getElementById('notes-share-cancel');

let currentBvid = null;
let currentTitle = '';
let applyingRemote = false;
let saveTimer = null;
let previewTimer = null;
let mathTimer = null;
let lastSavedMd = '';
let dirty = false;
let organizing = false;
const assetPreviewCache = new Map();
let hydrateToken = 0;

/** 预览防抖：打字时不每键全量渲染 */
const PREVIEW_DEBOUNCE_MS = 160;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || '';
}

function setHeading(title, { persistFull = true } = {}) {
  const full = String(title || '').trim();
  if (persistFull && full) currentTitle = full;
  if (!headingEl) return;
  const shown = (persistFull ? currentTitle || full : full) || '笔记';
  headingEl.textContent = shown.slice(0, 48);
  if (shown.length > 48) headingEl.title = shown;
  else headingEl.removeAttribute('title');
}

function setOrganizingUi(on) {
  organizing = Boolean(on);
  if (editorEl) editorEl.readOnly = organizing;
  sheetEl?.classList.toggle('is-organizing', organizing);
  if (organizing) organizeBtn?.setAttribute('disabled', '');
  else organizeBtn?.removeAttribute('disabled');
}

function rewriteLegacyAssetUrls(md) {
  return String(md || '').replace(
    /\]\(file:\/\/[^)\s]*\/notes-assets\/([^)\s]+)\)/g,
    (_m, rel) => {
      const parts = String(rel)
        .split('/')
        .filter(Boolean)
        .map((p) => encodeURIComponent(decodeURIComponent(p)));
      return `](bilinotes://asset/${parts.join('/')})`;
    }
  );
}

function sanitizeHtml(html) {
  if (window.DOMPurify?.sanitize) {
    return window.DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ['img'],
      ADD_ATTR: ['src', 'alt', 'title', 'target', 'rel', 'width', 'height'],
      ALLOWED_URI_REGEXP:
        /^(?:(?:(?:f|ht)tps?|bilinotes|mailto|tel|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    });
  }
  const div = document.createElement('div');
  div.textContent = html;
  return div.innerHTML;
}

function applyCachedAssetSrc(html) {
  let out = String(html || '');
  for (const [src, dataUrl] of assetPreviewCache.entries()) {
    if (!dataUrl) continue;
    out = out.split(src).join(dataUrl);
  }
  return out;
}

async function hydratePreviewImages() {
  if (!previewEl || !window.biliPet?.notesAssetDataUrl) return;
  const token = ++hydrateToken;
  const imgs = [...previewEl.querySelectorAll('img')];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('bilinotes://')) return;
      if (assetPreviewCache.has(src)) {
        img.src = assetPreviewCache.get(src);
        return;
      }
      try {
        const res = await window.biliPet.notesAssetDataUrl(src);
        if (token !== hydrateToken) return;
        if (res?.ok && res.dataUrl) {
          assetPreviewCache.set(src, res.dataUrl);
          img.src = res.dataUrl;
        }
      } catch {
        /* ignore */
      }
    })
  );
}

function renderMarkdown(md, { withMath = true } = {}) {
  if (!previewEl) return;
  const source = rewriteLegacyAssetUrls(md);
  clearTimeout(mathTimer);
  mathTimer = null;
  try {
    if (window.marked?.parse) {
      const raw = window.marked.parse(source, { gfm: true, breaks: true });
      previewEl.innerHTML = applyCachedAssetSrc(sanitizeHtml(raw));
    } else {
      previewEl.textContent = source;
    }

    if (!withMath) return;

    // KaTeX + 图片放到下一拍，先让 Markdown HTML 上屏，减少输入卡顿
    mathTimer = setTimeout(() => {
      mathTimer = null;
      if (!previewEl) return;
      if (window.renderMathInElement) {
        window.renderMathInElement(previewEl, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true },
          ],
          throwOnError: false,
        });
      }
      void hydratePreviewImages();
    }, 0);
  } catch (err) {
    previewEl.textContent = source;
    console.warn('[notes] render failed', err);
  }
}

/** 打字中：只防抖刷新预览；停手后再带公式 */
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    previewTimer = null;
    renderMarkdown(editorEl?.value || '', { withMath: true });
  }, PREVIEW_DEBOUNCE_MS);
}

function renderPreviewNow(md) {
  clearTimeout(previewTimer);
  previewTimer = null;
  renderMarkdown(md != null ? md : editorEl?.value || '', { withMath: true });
}

function isEditorDirty() {
  if (dirty) return true;
  return Boolean(editorEl && editorEl.value !== lastSavedMd);
}

function applyEditorText(md, { force = false } = {}) {
  if (!editorEl) return false;
  if (!force && isEditorDirty() && md !== editorEl.value) return false;

  applyingRemote = true;
  if (md !== editorEl.value) {
    const keepCursor = document.activeElement === editorEl && !organizing;
    const start = editorEl.selectionStart;
    const end = editorEl.selectionEnd;
    editorEl.value = md;
    if (keepCursor) {
      try {
        editorEl.setSelectionRange(start, end);
      } catch {
        /* ignore */
      }
    }
  }
  lastSavedMd = md;
  dirty = false;
  applyingRemote = false;
  renderPreviewNow(md);
  return true;
}

function cornellFallbackMd(notes) {
  const lines = [];
  if (notes.title) lines.push(`# ${notes.title}`, '');
  if (notes.cues?.length) {
    lines.push('## 线索', '');
    for (const c of notes.cues) lines.push(`- ${c}`);
    lines.push('');
  }
  if (notes.notes?.length) {
    lines.push('## 要点', '');
    for (const n of notes.notes) lines.push(`- ${n}`);
    lines.push('');
  }
  if (notes.summary) lines.push('## 总结', '', notes.summary, '');
  return lines.join('\n');
}

function setDocument({
  bodyMd,
  notes,
  title,
  bvid,
  status,
  fromDb,
  error,
  organized,
  force = false,
} = {}) {
  if (bvid) currentBvid = bvid;
  if (title || notes?.title) setHeading(title || notes.title);

  const md = rewriteLegacyAssetUrls(
    bodyMd != null
      ? String(bodyMd)
      : notes
        ? cornellFallbackMd(notes)
        : editorEl?.value || ''
  );

  const applied = applyEditorText(md, {
    force: Boolean(force) || organized || !isEditorDirty(),
  });

  if (!applied) {
    renderMarkdown(editorEl.value);
    setStatus(
      error
        ? `整理失败；已保留你正在编辑的内容：${error}`
        : '有远程更新，已保留你正在编辑的内容'
    );
    return;
  }

  if (error) setStatus(`失败：${error}`);
  else if (status) setStatus(status);
  else if (organized) setStatus('一键整理完成，已写入数据库');
  else if (fromDb) setStatus('已从数据库恢复');
  else setStatus('笔记已更新');
}

function savePayload() {
  return {
    bvid: currentBvid,
    mode: 'user',
    bodyMd: rewriteLegacyAssetUrls(editorEl?.value || ''),
    title: currentTitle || headingEl?.textContent || '',
  };
}

async function persistNow() {
  if (!window.biliPet?.notesSave) return { ok: false, error: 'no_api' };
  if (!currentBvid) {
    setStatus('尚无视频 bvid，打开跟播后再保存');
    return { ok: false, error: 'no_bvid' };
  }
  const payload = savePayload();
  if (payload.bodyMd === lastSavedMd && !dirty) return { ok: true, skipped: true };

  const res = await window.biliPet.notesSave(payload);
  if (res?.ok) {
    lastSavedMd = payload.bodyMd;
    dirty = false;
    if (!res.skipped) setStatus('已保存');
  } else {
    setStatus(`保存失败：${res?.error || 'unknown'}`);
  }
  return res;
}

function flushSaveSync() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!currentBvid || !window.biliPet?.notesSaveSync) return { ok: false };
  if (!dirty && editorEl?.value === lastSavedMd) return { ok: true, skipped: true };
  const payload = savePayload();
  try {
    const res = window.biliPet.notesSaveSync(payload);
    if (res?.ok) {
      lastSavedMd = payload.bodyMd;
      dirty = false;
    }
    return res || { ok: false };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return persistNow();
}

function scheduleSave() {
  if (applyingRemote || organizing) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistNow();
  }, 400);
}

async function runOrganize() {
  if (organizing) return;
  if (!currentBvid) {
    setStatus('尚无视频，无法整理');
    return;
  }
  setOrganizingUi(true);
  try {
    await flushSave();
    setStatus('正在一键整理…');
    const res = await window.biliPet?.notesOrganize?.({
      bvid: currentBvid,
      bodyMd: rewriteLegacyAssetUrls(editorEl?.value || ''),
      title: currentTitle || '',
    });
    if (res?.ok && res.doc) {
      setDocument({
        ...res.doc,
        bodyMd: res.doc.bodyMd,
        title: res.doc.title || currentTitle,
        organized: true,
        force: true,
        status: '一键整理完成，已写入数据库',
      });
    } else if (!res?.ok) {
      setStatus(
        res?.error === 'llm_disabled'
          ? '未启用 LLM，请检查 .env'
          : `整理失败：${res?.error || 'unknown'}`
      );
    }
  } finally {
    setOrganizingUi(false);
  }
}

function insertAtCursor(text) {
  if (!editorEl || editorEl.readOnly) return;
  const start = editorEl.selectionStart ?? editorEl.value.length;
  const end = editorEl.selectionEnd ?? start;
  const before = editorEl.value.slice(0, start);
  const after = editorEl.value.slice(end);
  const padBefore = before && !/\n$/.test(before) ? '\n\n' : before ? '\n' : '';
  const padAfter = after && !/^\n/.test(after) ? '\n\n' : '\n';
  editorEl.value = `${before}${padBefore}${text}${padAfter}${after}`;
  const pos = (before + padBefore + text + padAfter).length;
  editorEl.focus();
  editorEl.setSelectionRange(pos, pos);
  dirty = true;
  renderMarkdown(editorEl.value);
  scheduleSave();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

async function handleImageFiles(files) {
  if (organizing) {
    setStatus('正在整理中，请稍后再拖入截图');
    return;
  }
  const images = [...files].filter((f) => /^image\//.test(f.type));
  if (!images.length) return;
  for (const file of images) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const res = await window.biliPet?.notesSaveAsset?.({
        bvid: currentBvid,
        dataUrl,
      });
      if (!res?.ok) {
        if (res?.error === 'too_large') {
          setStatus('截图过大（上限约 8MB），请压缩后再试');
        } else {
          setStatus(`截图保存失败：${res?.error || 'unknown'}`);
        }
        continue;
      }
      if (res.asset?.url && res.asset?.dataUrl) {
        assetPreviewCache.set(res.asset.url, res.asset.dataUrl);
      }
      insertAtCursor(res.asset.markdown);
      setStatus('截图已插入，预览已更新');
    } catch (err) {
      setStatus(`截图失败：${err.message || err}`);
    }
  }
}

async function switchToBvid(nextBvid, { title, status } = {}) {
  const key = String(nextBvid || '').trim();
  if (!key) return;
  const prev = currentBvid;
  if (prev && prev !== key) {
    await flushSave();
    dirty = false;
    lastSavedMd = '';
    if (editorEl) editorEl.value = '';
    renderMarkdown('');
  }
  currentBvid = key;
  if (title) setHeading(title);
  const res = await window.biliPet?.notesLoad?.(key);
  if (res?.doc) {
    setDocument({
      ...res.doc,
      fromDb: true,
      force: true,
      status:
        status ||
        (prev && prev !== key ? '已切换到新视频笔记' : '已载入本片笔记'),
    });
  } else {
    setStatus(
      status ||
        (prev && prev !== key ? '新视频：开始手写笔记吧' : '开始手写笔记吧')
    );
  }
}

function handleEvent(payload) {
  if (!payload?.kind) return;

  switch (payload.kind) {
    case 'notes_status':
      setStatus(payload.status || '');
      break;

    case 'notes_document':
    case 'notes_update':
      // 整理结果由 IPC 回写一次即可，忽略广播避免双写
      if (organizing) break;
      if (payload.organized) break;
      setDocument({
        bodyMd: payload.bodyMd,
        notes: payload.notes,
        title: payload.title || payload.notes?.title,
        bvid: payload.bvid,
        status: payload.status,
        fromDb: payload.fromDb,
        error: payload.error,
        organized: false,
        force: false,
      });
      break;

    case 'session_start': {
      const next =
        payload.bvid || payload.modelInput?.video?.bvid || currentBvid;
      void switchToBvid(next, {
        title: payload.title || payload.modelInput?.video?.title,
        status:
          currentBvid && next && currentBvid !== next
            ? '已切换到新视频笔记'
            : '新会话开始，可手写笔记',
      });
      break;
    }

    case 'session_meta':
      if (payload.title) setHeading(payload.title);
      if (payload.bvid && payload.bvid !== currentBvid) {
        void switchToBvid(payload.bvid, { title: payload.title });
      } else if (payload.bvid) {
        currentBvid = payload.bvid;
      }
      break;

    case 'progress':
    case 'heartbeat':
      if (payload.title) setHeading(payload.title);
      if (payload.bvid) currentBvid = payload.bvid;
      break;

    case 'session_end':
      setStatus('跟播结束；需要可再点「一键整理」');
      break;

    default:
      break;
  }
}

organizeBtn?.addEventListener('click', () => {
  void runOrganize();
});

function hideSharePanel() {
  if (sharePanel) sharePanel.hidden = true;
}

async function openSharePanel() {
  if (!currentBvid) {
    setStatus('尚无视频笔记，无法传给好友');
    return;
  }
  await flushSave();
  const body = String(editorEl?.value || '').trim();
  if (!body) {
    setStatus('笔记是空的，写点内容再传');
    return;
  }
  const res = await window.biliPet?.friendsList?.();
  if (!res?.ok) {
    setStatus(`无法加载好友：${res?.error || '请先登录云端'}`);
    return;
  }
  const friends = Array.isArray(res.friends) ? res.friends : [];
  if (shareList) shareList.innerHTML = '';
  if (shareEmpty) shareEmpty.hidden = friends.length > 0;
  for (const f of friends) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.uname || `UID ${f.uid}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '发送';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      setStatus(`正在传给「${name.textContent}」…`);
      const r = await window.biliPet?.friendsNoteShare?.(f.uid, currentBvid);
      if (r?.ok) {
        setStatus(`已传给「${name.textContent}」，等待对方接收`);
        hideSharePanel();
      } else if (r?.error === 'already_sent') {
        setStatus('这篇笔记已经传给过对方，不能再发');
        btn.disabled = false;
      } else {
        setStatus(`发送失败：${r?.error || 'unknown'}`);
        btn.disabled = false;
      }
    });
    li.appendChild(name);
    li.appendChild(btn);
    shareList?.appendChild(li);
  }
  if (sharePanel) sharePanel.hidden = false;
}

shareBtn?.addEventListener('click', () => {
  void openSharePanel();
});

shareCancel?.addEventListener('click', () => {
  hideSharePanel();
});

editorEl?.addEventListener('input', () => {
  if (applyingRemote || organizing) return;
  dirty = true;
  schedulePreview();
  scheduleSave();
});

window.addEventListener('beforeunload', () => {
  flushSaveSync();
});

sheetEl?.addEventListener('dragover', (e) => {
  if (organizing) return;
  e.preventDefault();
  sheetEl.classList.add('is-drop');
});
sheetEl?.addEventListener('dragleave', () => {
  sheetEl.classList.remove('is-drop');
});
sheetEl?.addEventListener('drop', (e) => {
  e.preventDefault();
  sheetEl.classList.remove('is-drop');
  if (organizing) {
    setStatus('正在整理中，请稍后再拖入截图');
    return;
  }
  if (e.dataTransfer?.files?.length) {
    void handleImageFiles(e.dataTransfer.files);
  }
});

renderPreviewNow(editorEl?.value || '');

if (window.biliPet?.onEvent) {
  window.biliPet.onEvent(handleEvent);
  window.biliPet.getLatest?.().then((latest) => {
    if (latest) handleEvent(latest);
    const bvid = latest?.bvid || latest?.modelInput?.video?.bvid;
    if (bvid) {
      void switchToBvid(bvid, {
        title: latest?.title || latest?.modelInput?.video?.title,
        status: '已从数据库恢复',
      });
    }
  });
} else {
  setStatus('桥接未就绪');
}
