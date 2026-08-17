/**
 * 根据正文主要文字判断输出语言：zh（中文）或 en（英文）。
 * 中文笔记常夹杂英文术语，故 CJK 占比较低时仍倾向 zh。
 * 纯拉丁（即使很短，如 "Limits"）一律视为英文。
 */
function flattenText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input);
  }
  if (Array.isArray(input)) {
    return input.map(flattenText).filter(Boolean).join('\n');
  }
  if (typeof input === 'object') {
    const parts = [];
    for (const v of Object.values(input)) {
      const s = flattenText(v);
      if (s) parts.push(s);
    }
    return parts.join('\n');
  }
  return '';
}

function detectContentLang(...parts) {
  const text = parts.map(flattenText).join('\n');
  const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const total = cjk + latin;
  if (total === 0) return 'zh';
  // 无汉字、有拉丁 → 英文（短节点如 Chain Rule / Limits 也算）
  if (cjk === 0) return 'en';
  if (latin === 0) return 'zh';
  // 中文笔记里英文术语会拉高 latin；CJK 达到约 18% 即视为中文为主
  if (cjk / total >= 0.18) return 'zh';
  return 'en';
}

/** 按笔记切块正文判语言（导图生成/展开以此为准） */
function detectChunksLang(chunks) {
  return detectContentLang(
    (chunks || []).map((c) => `${c?.heading || ''}\n${c?.text || ''}`)
  );
}

/** 导图节点截断长度：英文短语需要更多字符 */
function nodeLabelMaxLen(lang, tier = 'leaf') {
  const en = lang === 'en';
  if (tier === 'root') return en ? 56 : 24;
  if (tier === 'module') return en ? 44 : 16;
  return en ? 48 : 20;
}

function langInstruction(lang) {
  if (lang === 'en') {
    return (
      'CRITICAL language lock: contentLanguage=en (from noteChunks). ' +
      'Write EVERY node/label in English only. ' +
      'Do NOT use Chinese characters anywhere in the output.'
    );
  }
  return '输出语言锁定：contentLanguage=zh（来自笔记切块）。节点与正文必须用中文。';
}

/** 拼进 system，压过中文提示词对模型的语言惯性 */
function langSystemLock(lang) {
  if (lang === 'en') {
    return (
      '\n\nLANGUAGE LOCK (overrides everything above): ' +
      'noteChunks are primarily English. ' +
      'Your entire output MUST be English. ' +
      'Zero Chinese characters allowed in headings or labels.'
    );
  }
  return '';
}

module.exports = {
  detectContentLang,
  detectChunksLang,
  nodeLabelMaxLen,
  langInstruction,
  langSystemLock,
  flattenText,
};
