/**
 * 统一事件信封：现阶段只做记录，字段预留给后续 AI。
 * 不采集评论正文、搜索词、页面 HTML。
 */
const BiliSchema = (() => {
  const cfg = () => globalThis.BILI_PET_CONFIG || {};

  function newSessionId(bvid) {
    return `sess_${bvid || 'unknown'}_${Date.now().toString(36)}_${Math.random()
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

  /** 把字幕窗口压成一段纯文本，方便以后直接喂给模型 */
  function contextText(lines = []) {
    return lines
      .map((l) => (l?.content || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  return { newSessionId, envelope, contextText };
})();

globalThis.BiliSchema = BiliSchema;
