const BiliSchema = (() => {
  const cfg = () => globalThis.BILI_PET_CONFIG || {};

  /** P1 用裸 BV；P2+ 为 BVxxx#pN，与桌面笔记主键一致 */
  function makeNoteKey(bvid, page = 1) {
    const bv = String(bvid || '').trim().match(/BV[\w]+/i)?.[0] || '';
    if (!bv) return '';
    const p = Math.max(1, Number(page) || 1);
    return p <= 1 ? bv : `${bv}#p${p}`;
  }

  function newSessionId(bvid, page = 1) {
    const key = makeNoteKey(bvid, page) || bvid || 'unknown';
    return `sess_${key}_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }

  function envelope(kind, data = {}) {
    return {
      v: cfg().SCHEMA_VERSION || 1,
      source: cfg().SOURCE || 'bili-pet-bridge',
      kind,
      ts: data.ts || Date.now(),
      ...data,
    };
  }

  function contextText(lines = []) {
    return lines
      .map((l) => (l?.content || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  function buildModelInput({
    meta = {},
    lines = [],
    t = 0,
    currentSubtitle = null,
    sessionId = null,
    paused = null,
  } = {}) {
    const before = cfg().SUBTITLE_CONTEXT_BEFORE_SEC ?? 20;
    const after = cfg().SUBTITLE_CONTEXT_AFTER_SEC ?? 8;
    const cue = currentSubtitle
      ? {
          from: currentSubtitle.from,
          to: currentSubtitle.to,
          content: currentSubtitle.content,
        }
      : null;

    return {
      v: cfg().SCHEMA_VERSION || 1,
      sessionId: sessionId || null,
      video: {
        bvid: meta.bvid || null,
        aid: meta.aid ?? null,
        title: meta.title || '',
        owner: meta.owner || '',
        cid: meta.cid ?? null,
        page: meta.page ?? 1,
        part: meta.part || meta.title || '',
        duration: Number(meta.duration) || 0,
      },
      playback: {
        t: Number(t) || 0,
        paused: paused == null ? null : Boolean(paused),
        currentSubtitle: cue,
      },
      context: {
        text: contextText(lines),
        windowSec: { before, after },
      },
    };
  }

  return { newSessionId, envelope, contextText, buildModelInput, makeNoteKey };
})();//返回BiliSchema对象，拼接json

globalThis.BiliSchema = BiliSchema;
