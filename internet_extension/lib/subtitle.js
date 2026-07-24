const BiliSubtitle = (() => {
  const cache = new Map();
  let pageFetchChain = Promise.resolve();

  function absUrl(url) {
    if (!url) return '';
    if (url.startsWith('//')) return `https:${url}`;
    return url;
  }

  function looksLikeCueBody(body) {
    if (!Array.isArray(body) || !body.length) return false;
    const sample = body.slice(0, 8);
    return sample.every(
      (line) =>
        line &&
        typeof line === 'object' &&
        typeof line.content === 'string' &&
        (typeof line.from === 'number' || typeof line.to === 'number')
    );
  }

  function fetchJsonViaPage(url) {
    const run = () =>
      new Promise((resolve, reject) => {
        const id = `fetch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error('page fetch timeout'));
        }, 12000);

        function onMsg(event) {
          if (event.source !== window) return;
          const msg = event.data;
          if (!msg || msg.__biliPet !== true || msg.type !== 'fetch_res' || msg.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          if (msg.ok) resolve(msg.data);
          else reject(new Error(msg.error || 'page fetch failed'));
        }

        window.addEventListener('message', onMsg);
        window.postMessage({ __biliPet: true, type: 'fetch_req', id, url }, '*');
      });

    const next = pageFetchChain.then(run, run);
    pageFetchChain = next.catch(() => {});
    return next;
  }

  async function fetchJson(url) {
    const absolute = absUrl(url);

    try {
      return await fetchJsonViaPage(absolute);
    } catch (_) {}

    try {
      const res = await fetch(absolute, {
        credentials: 'include',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://www.bilibili.com',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (_) {}

    const res = await chrome.runtime.sendMessage({
      type: 'BILI_PET_FETCH_JSON',
      url: absolute,
    });
    if (res?.ok) return res.data;
    throw new Error(res?.error || 'background fetch failed');
  }

  async function getView(bvid) {
    const data = await fetchJson(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`
    );
    if (data.code !== 0) throw new Error(`view API: ${data.message || data.code}`);
    return data.data;
  }

  async function resolveCid(bvid, page = 1) {
    const view = await getView(bvid);
    const pages = view.pages || [];
    const target = pages.find((p) => p.page === page) || pages[0];
    return {
      aid: view.aid,
      bvid: view.bvid,
      title: view.title,
      owner: view.owner?.name || '',
      cid: target?.cid,
      page: target?.page || 1,
      part: target?.part || view.title,
      duration: Number(view.duration) || Number(target?.duration) || 0,
      pages,
    };
  }

  function pickPreferred(subtitles = []) {
    return (
      subtitles.find((s) => /^(zh-CN|zh-Hans)$/i.test(String(s.lan || ''))) ||
      subtitles.find((s) => /zh-CN|zh-Hans/i.test(String(s.lan || '')) && !/ai-/i.test(String(s.lan || ''))) ||
      subtitles.find((s) => String(s.lan_doc || '').includes('中') && !String(s.lan_doc || '').includes('自动')) ||
      subtitles.find((s) => /ai-zh/i.test(String(s.lan || ''))) ||
      subtitles.find((s) => String(s.lan_doc || '').includes('中')) ||
      subtitles[0] ||
      null
    );
  }

  function subtitleUrlMatchesVideo(subtitleUrl, aid, cid) {
    const url = absUrl(subtitleUrl);
    if (!url) return false;
    if (!/ai_subtitle|aisubtitle/i.test(url)) return true;
    if (aid == null || cid == null) return true;
    const path = url.split('?')[0];
    const a = String(aid);
    const c = String(cid);
    return path.includes(`${a}${c}`) || (path.includes(a) && path.includes(c));
  }

  function bodyFitsDuration(body, durationSec) {
    if (!durationSec || !body?.length) return true;
    let maxTo = 0;
    for (const line of body) {
      const t = Number(line?.to ?? line?.from ?? 0);
      if (t > maxTo) maxTo = t;
    }
    return maxTo <= durationSec * 1.2 + 45;
  }

  async function listSubtitles(bvid, cid) {
    const tryUrls = [
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    ];
    let lastError = null;
    let needLogin = false;
    let best = [];

    for (const url of tryUrls) {
      try {
        const data = await fetchJson(url);
        if (data.code !== 0) {
          lastError = new Error(`player API: ${data.message || data.code}`);
          continue;
        }
        const subs = data.data?.subtitle?.subtitles || [];
        needLogin = needLogin || Boolean(data.data?.need_login_subtitle);
        if (subs.length) return { subtitles: subs, needLogin };
        best = subs;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError && !(best && best.length)) throw lastError;
    return { subtitles: best || [], needLogin };
  }

  async function downloadSubtitleBody(subtitleUrl) {
    const url = absUrl(subtitleUrl);
    const data = await fetchJson(url);
    if (looksLikeCueBody(data.body)) return data.body;
    return Array.isArray(data.body) ? data.body : [];
  }

  function toPlainText(body = []) {
    return body
      .slice()
      .sort((a, b) => (a.from || 0) - (b.from || 0))
      .map((l) => String(l.content || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  /**
   * @param {{ force?: boolean }} [opts]
   */
  async function load(bvid, cid, opts = {}) {
    const key = `${bvid}:${cid}`;
    if (!opts.force && cache.has(key)) return cache.get(key);

    const meta = await resolveCid(bvid);
    const realCid = cid || meta.cid;
    if (!realCid) throw new Error('缺少 cid');
    if (meta.bvid && bvid && meta.bvid !== bvid) {
      throw new Error(`bvid 不匹配: want ${bvid} got ${meta.bvid}`);
    }

    const empty = (status) => ({
      meta: { ...meta, cid: realCid, needLogin: status === 'need_login', lan: null, lan_doc: null },
      body: [],
      fullText: '',
      status,
      lock: { bvid, cid: realCid, aid: meta.aid },
    });

    const { subtitles, needLogin } = await listSubtitles(bvid, realCid);
    if (!subtitles.length) return empty(needLogin ? 'need_login' : 'empty');
    const ranked = [];
    const preferred = pickPreferred(subtitles);
    if (preferred) ranked.push(preferred);
    for (const s of subtitles) {
      if (!ranked.includes(s)) ranked.push(s);
    }

    let lastErr = null;
    for (const track of ranked) {
      if (!track?.subtitle_url) continue;
      if (!subtitleUrlMatchesVideo(track.subtitle_url, meta.aid, realCid)) {
        lastErr = new Error('字幕 URL 与 aid/cid 不匹配，已跳过');
        continue;
      }
      try {
        const body = await downloadSubtitleBody(track.subtitle_url);
        if (!body.length) continue;
        if (!bodyFitsDuration(body, meta.duration)) {
          lastErr = new Error('字幕时长与视频不符，已跳过（疑似串台文件）');
          continue;
        }
        const packed = {
          meta: {
            ...meta,
            cid: realCid,
            needLogin,
            lan: track.lan,
            lan_doc: track.lan_doc,
            subtitle_id: track.id,
            subtitle_url: track.subtitle_url,
          },
          body,
          fullText: toPlainText(body),
          status: 'ok',
          lock: { bvid, cid: realCid, aid: meta.aid },
        };
        cache.set(key, packed);
        return packed;
      } catch (err) {
        lastErr = err;
      }
    }

    if (lastErr) {
      return {
        ...empty(needLogin ? 'need_login' : 'empty'),
        meta: {
          ...meta,
          cid: realCid,
          needLogin,
          lan: null,
          lan_doc: null,
          skipReason: String(lastErr.message || lastErr),
        },
      };
    }
    return empty(needLogin ? 'need_login' : 'empty');
  }

  function atTime(body, t) {
    if (!body?.length) return null;
    return body.find((line) => t >= line.from && t < line.to) || null;
  }

  function windowAround(body, t, before = 15, after = 5) {
    if (!body?.length) return [];
    const start = t - before;
    const end = t + after;
    return body.filter((line) => line.to >= start && line.from <= end);
  }

  function clearCache(bvid) {
    if (!bvid) {
      cache.clear();
      return;
    }
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${bvid}:`)) cache.delete(key);
    }
  }

  return {
    load,
    atTime,
    windowAround,
    toPlainText,
    clearCache,
    resolveCid,
    getView,
  };
})();
