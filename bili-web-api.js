'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeBvid } = require('./notes-db');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const COOKIE_FILE = path.join(__dirname, '.bili-pet-bili-session.json');

/** @type {string} */
let cachedCookieHeader = '';
/** @type {number} */
let cookieUpdatedAt = 0;

function loadPersistedCookie() {
  try {
    if (!fs.existsSync(COOKIE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    const cookie = String(raw?.cookieHeader || '').trim();
    if (!cookie) return;
    cachedCookieHeader = cookie;
    cookieUpdatedAt = Number(raw?.updatedAt) || Date.now();
  } catch {
    /* ignore */
  }
}

function persistCookie() {
  try {
    fs.writeFileSync(
      COOKIE_FILE,
      `${JSON.stringify(
        {
          cookieHeader: cachedCookieHeader,
          updatedAt: cookieUpdatedAt,
        },
        null,
        2
      )}\n`,
      'utf8'
    );
  } catch (err) {
    console.warn('[bili-pet] persist bili cookie failed:', err?.message || err);
  }
}

loadPersistedCookie();

function setBiliCookieHeader(header) {
  const next = String(header || '').trim();
  if (!next) return false;
  // Avoid clobbering a complete cookie with an incomplete one
  const nextHasCsrf = /(?:^|;\s*)bili_jct=/.test(next);
  const prevHasCsrf = /(?:^|;\s*)bili_jct=/.test(cachedCookieHeader);
  if (cachedCookieHeader && prevHasCsrf && !nextHasCsrf) {
    // #region agent log
    fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'C',location:'bili-web-api.js:setBiliCookieHeader',message:'rejected incomplete cookie',data:{prevHasCsrf,nextHasCsrf,nextLen:next.length,prevLen:cachedCookieHeader.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  }
  cachedCookieHeader = next;
  cookieUpdatedAt = Date.now();
  persistCookie();
  // #region agent log
  fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'C',location:'bili-web-api.js:setBiliCookieHeader',message:'cookie accepted',data:{hasCsrf:nextHasCsrf,hasSess:/SESSDATA=/.test(next),len:next.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  return true;
}

function getBiliCookieHeader() {
  return cachedCookieHeader;
}

function cookieField(name) {
  const key = String(name || '').trim();
  if (!key || !cachedCookieHeader) return '';
  const re = new RegExp(`(?:^|;\\s*)${key}=([^;]*)`);
  const m = cachedCookieHeader.match(re);
  return m ? decodeURIComponent(m[1].trim()) : '';
}

function getCsrf() {
  return cookieField('bili_jct');
}

function getMidFromCookie() {
  return cookieField('DedeUserID');
}

function getCookieAuthStatus() {
  const cookie = getBiliCookieHeader();
  const csrf = getCsrf();
  const sess = cookieField('SESSDATA');
  return {
    hasCookie: Boolean(cookie),
    hasCsrf: Boolean(csrf),
    hasSessdata: Boolean(sess),
    ok: Boolean(cookie && csrf),
  };
}

async function viaExtension(action, payload = {}) {
  let enqueue;
  try {
    ({ enqueueExtensionCommand: enqueue } = require('./bridge-server'));
  } catch {
    return null;
  }
  if (typeof enqueue !== 'function') return null;
  try {
    const result = await enqueue({
      action,
      bvid: payload.bvid,
      timeoutMs: payload.timeoutMs || 20000,
    });
    return result;
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg === 'extension_command_timeout') {
      return {
        ok: false,
        error: 'timeout',
        message: '插件没有在时限内完成操作。请确认插件已启用并打开过 B 站页面。',
      };
    }
    return {
      ok: false,
      error: 'extension',
      message: `插件执行失败：${msg}`,
    };
  }
}

async function biliRequest(url, { method = 'GET', body = null, form = null } = {}) {
  const cookie = getBiliCookieHeader();
  if (!cookie) {
    return { ok: false, error: 'no_cookie', message: '未拿到 B 站登录态，请确认浏览器已登录且插件在线。' };
  }

  const headers = {
    Cookie: cookie,
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
  };

  let payload = body;
  if (form && typeof form === 'object') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    payload = new URLSearchParams(
      Object.entries(form)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => [k, String(v)])
    ).toString();
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : payload,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'network',
      message: err?.message || String(err),
    };
  }

  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return {
      ok: false,
      error: 'bad_json',
      status: res.status,
      message: text.slice(0, 200) || `HTTP ${res.status}`,
    };
  }

  const code = data?.code;
  if (code !== 0 && code !== '0') {
    return {
      ok: false,
      error: 'api',
      code,
      message: String(data?.message || data?.msg || `B站返回 ${code}`),
      data,
    };
  }

  return { ok: true, data: data?.data ?? data, raw: data };
}

async function resolveVideoMeta(bvidOrAid) {
  const raw = String(bvidOrAid || '').trim();
  const bvid = normalizeBvid(raw);
  if (!bvid && !/^\d+$/.test(raw)) {
    return { ok: false, error: 'invalid_bvid', message: '无效的视频号' };
  }

  const qs = bvid
    ? `bvid=${encodeURIComponent(bvid)}`
    : `aid=${encodeURIComponent(raw)}`;
  const result = await biliRequest(
    `https://api.bilibili.com/x/web-interface/view?${qs}`
  );
  if (!result.ok) return result;

  const d = result.data || {};
  const aid = Number(d.aid);
  const id = normalizeBvid(d.bvid) || bvid;
  if (!aid || !id) {
    return { ok: false, error: 'not_found', message: '找不到该视频' };
  }
  return {
    ok: true,
    aid,
    bvid: id,
    title: String(d.title || '').trim(),
  };
}

async function addToWatchLaterLocal(bvid) {
  const csrf = getCsrf();
  // #region agent log
  fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'A',location:'bili-web-api.js:addToWatchLaterLocal',message:'local watch_later csrf check',data:{hasCsrf:Boolean(csrf),auth:getCookieAuthStatus(),bvid:String(bvid||'').slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!csrf) {
    return {
      ok: false,
      error: 'no_csrf',
      message:
        '缺少 B 站写权限（bili_jct）。请重新加载浏览器插件，打开已登录的 B 站页面后再试。',
    };
  }

  const meta = await resolveVideoMeta(bvid);
  if (!meta.ok) return meta;

  const result = await biliRequest(
    'https://api.bilibili.com/x/v2/history/toview/add',
    {
      method: 'POST',
      form: {
        bvid: meta.bvid,
        csrf,
      },
    }
  );

  if (!result.ok) {
    if (result.code === 90001 || /已经/.test(String(result.message || ''))) {
      return {
        ok: true,
        already: true,
        bvid: meta.bvid,
        title: meta.title,
        message: `「${meta.title || meta.bvid}」已在 B 站稍后再看里。`,
        via: 'local',
      };
    }
    return {
      ...result,
      message: mapBiliError(result, '加入稍后再看失败'),
      via: 'local',
    };
  }

  return {
    ok: true,
    bvid: meta.bvid,
    title: meta.title,
    message: `已把「${meta.title || meta.bvid}」加入 B 站稍后再看。`,
    via: 'local',
  };
}

async function addToWatchLater(bvid) {
  const key = normalizeBvid(bvid) || String(bvid || '').trim();
  if (!key) {
    return { ok: false, error: 'invalid_bvid', message: '无效的视频号' };
  }

  const beforeAuth = getCookieAuthStatus();
  // 优先插件代发（浏览器真实会话）
  const ext = await viaExtension('watch_later', { bvid: key });
  // #region agent log
  fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'B',location:'bili-web-api.js:addToWatchLater',message:'extension watch_later result',data:{beforeAuth,extOk:ext?.ok??null,extError:ext?.error||null,extMsg:String(ext?.message||'').slice(0,80),extNull:ext==null,bvid:key.slice(0,20)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (ext?.ok) {
    return {
      ok: true,
      message: ext.message || '已加入稍后再看。',
      via: 'extension',
      data: ext.data,
    };
  }
  // 插件明确业务失败（非超时）→ 直接返回
  if (ext && ext.error !== 'timeout' && ext.error !== 'extension_command_dropped') {
    if (!getCookieAuthStatus().ok) {
      // #region agent log
      fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'E',location:'bili-web-api.js:addToWatchLater',message:'return ext failure without local fallback',data:{extError:ext.error,extMsg:String(ext.message||'').slice(0,80)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      return {
        ok: false,
        message: ext.message || '加入稍后再看失败。',
        via: 'extension',
        error: ext.error,
      };
    }
  }

  // #region agent log
  fetch('http://127.0.0.1:7383/ingest/5054654b-aba0-404a-ac16-c602aa116055',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d429e3'},body:JSON.stringify({sessionId:'d429e3',hypothesisId:'B',location:'bili-web-api.js:addToWatchLater',message:'falling back to local watch_later',data:{auth:getCookieAuthStatus(),extError:ext?.error||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  return addToWatchLaterLocal(key);
}

/**
 * 最近一条稿件观看记录（用于「最近看的视频」）
 * GET /x/web-interface/history/cursor
 */
async function getRecentWatched(limit = 1) {
  const ps = Math.max(1, Math.min(Number(limit) || 1, 20));

  const ext = await viaExtension('recent_watched', { timeoutMs: 15000 });
  if (ext?.ok && ext.data?.bvid) {
    return {
      ok: true,
      bvid: normalizeBvid(ext.data.bvid) || ext.data.bvid,
      title: String(ext.data.title || '').trim(),
      aid: ext.data.aid,
      via: 'extension',
    };
  }

  if (!getCookieAuthStatus().ok) {
    return {
      ok: false,
      error: 'no_csrf',
      message:
        ext?.message ||
        '无法读取观看记录：B 站写权限未同步。请重新加载插件并打开已登录的 B 站页。',
    };
  }

  const result = await biliRequest(
    `https://api.bilibili.com/x/web-interface/history/cursor?max=0&view_at=0&business=archive&ps=${ps}`
  );
  if (!result.ok) {
    return {
      ...result,
      message: mapBiliError(result, '获取观看记录失败'),
    };
  }

  const list = Array.isArray(result.data?.list) ? result.data.list : [];
  for (const item of list) {
    const hist = item?.history || item || {};
    const bvid = normalizeBvid(hist.bvid || item?.bvid);
    const aid = Number(hist.oid || hist.aid || item?.aid) || 0;
    const biz = String(hist.business || item?.business || '');
    if (biz && biz !== 'archive' && biz !== 'pgc') {
      if (!bvid && !aid) continue;
    }
    if (bvid) {
      return {
        ok: true,
        bvid,
        aid: aid || undefined,
        title: String(item?.title || '').trim(),
        via: 'local',
      };
    }
    if (aid) {
      const meta = await resolveVideoMeta(String(aid));
      if (meta.ok) {
        return {
          ok: true,
          bvid: meta.bvid,
          aid: meta.aid,
          title: meta.title || String(item?.title || '').trim(),
          via: 'local',
        };
      }
    }
  }

  return {
    ok: false,
    error: 'empty_history',
    message: '观看记录里没有找到视频。',
  };
}

async function listCreatedFavFolders(upMid) {
  const mid = String(upMid || getMidFromCookie() || '').trim();
  if (!mid) {
    return { ok: false, error: 'no_mid', message: '无法识别 B 站账号。' };
  }
  return biliRequest(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(mid)}`
  );
}

function pickDefaultFavFolder(list) {
  const folders = Array.isArray(list) ? list : [];
  if (!folders.length) return null;
  const byTitle = folders.find((f) => /默认收藏夹/.test(String(f?.title || '')));
  if (byTitle) return byTitle;
  const byAttr = folders.find((f) => (Number(f?.attr) & 1) === 0 && Number(f?.attr) >= 0);
  return byAttr || folders[0];
}

async function addToDefaultFavoriteLocal(bvid) {
  const csrf = getCsrf();
  if (!csrf) {
    return {
      ok: false,
      error: 'no_csrf',
      message:
        '缺少 B 站写权限（bili_jct）。请重新加载浏览器插件，打开已登录的 B 站页面后再试。',
    };
  }

  const meta = await resolveVideoMeta(bvid);
  if (!meta.ok) return meta;

  const foldersRes = await listCreatedFavFolders();
  if (!foldersRes.ok) {
    return {
      ...foldersRes,
      message: mapBiliError(foldersRes, '获取收藏夹失败'),
      via: 'local',
    };
  }

  const folder = pickDefaultFavFolder(foldersRes.data?.list || foldersRes.data);
  const mediaId = Number(folder?.id);
  if (!mediaId) {
    return {
      ok: false,
      error: 'no_folder',
      message: '没有找到可用的收藏夹，请先在 B 站创建收藏夹。',
      via: 'local',
    };
  }

  const result = await biliRequest(
    'https://api.bilibili.com/x/v3/fav/resource/deal',
    {
      method: 'POST',
      form: {
        rid: meta.aid,
        type: 2,
        add_media_ids: mediaId,
        platform: 'web',
        csrf,
      },
    }
  );

  if (!result.ok) {
    if (result.code === 11201 || /已经收藏/.test(String(result.message || ''))) {
      return {
        ok: true,
        already: true,
        bvid: meta.bvid,
        title: meta.title,
        folderTitle: String(folder.title || '默认收藏夹'),
        message: `「${meta.title || meta.bvid}」已在「${folder.title || '默认收藏夹'}」里。`,
        via: 'local',
      };
    }
    return {
      ...result,
      message: mapBiliError(result, '加入收藏失败'),
      via: 'local',
    };
  }

  return {
    ok: true,
    bvid: meta.bvid,
    title: meta.title,
    folderTitle: String(folder.title || '默认收藏夹'),
    message: `已把「${meta.title || meta.bvid}」加入 B 站「${folder.title || '默认收藏夹'}」。`,
    via: 'local',
  };
}

async function addToDefaultFavorite(bvid) {
  const key = normalizeBvid(bvid) || String(bvid || '').trim();
  if (!key) {
    return { ok: false, error: 'invalid_bvid', message: '无效的视频号' };
  }

  const ext = await viaExtension('favorite', { bvid: key });
  if (ext?.ok) {
    return {
      ok: true,
      message: ext.message || '已加入收藏。',
      via: 'extension',
      data: ext.data,
    };
  }
  if (ext && ext.error !== 'timeout' && ext.error !== 'extension_command_dropped') {
    if (!getCookieAuthStatus().ok) {
      return {
        ok: false,
        message: ext.message || '加入收藏失败。',
        via: 'extension',
        error: ext.error,
      };
    }
  }

  return addToDefaultFavoriteLocal(key);
}

function mapBiliError(result, fallback) {
  const code = result?.code;
  const raw = String(result?.message || '').trim();
  if (code === -400 || raw === '请求错误') {
    return 'B 站拒绝了请求（参数/登录态异常）。请打开已登录的 bilibili.com 页面后再试。';
  }
  if (code === -101 || code === -111) {
    return 'B 站登录已失效，请在浏览器重新登录后再试。';
  }
  if (code === -352 || code === -412) {
    return 'B 站风控拦截了这次请求，稍后再试或在网页里手动操作一次。';
  }
  return String(result?.message || fallback || 'B站操作失败');
}

module.exports = {
  setBiliCookieHeader,
  addToWatchLater,
  addToDefaultFavorite,
  getRecentWatched,
};
