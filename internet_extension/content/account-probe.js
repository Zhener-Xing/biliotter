/**
 * 在任意 B 站页面探测当前登录 UID（Cookie 可读 或 nav 接口）。
 * 供 Cookie API 漏读时兜底。
 */
(() => {
  function pickUid(value) {
    const s = String(value ?? '').trim();
    if (!s || s === '0') return null;
    return s;
  }

  function fromCookie() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)DedeUserID=([^;]+)/);
      return pickUid(m?.[1]);
    } catch {
      return null;
    }
  }

  async function fromNavApi() {
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.code !== 0) return null;
      return pickUid(data?.data?.mid);
    } catch {
      return null;
    }
  }

  async function detectAndReport() {
    let uid = fromCookie();
    if (!uid) uid = await fromNavApi();
    if (!uid) return;
    try {
      chrome.runtime.sendMessage({ type: 'BILI_PET_ACCOUNT_HINT', uid });
    } catch (_) {}
  }

  detectAndReport();
  setTimeout(detectAndReport, 1200);
  setInterval(detectAndReport, 60_000);
})();
