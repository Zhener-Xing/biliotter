(() => {
  if (window.__biliPetHookInstalled) return;
  window.__biliPetHookInstalled = true;

  const origFetch = window.fetch;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__biliPet !== true || msg.type !== 'fetch_req') return;

    const { id, url } = msg;
    (async () => {
      try {
        const res = await origFetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
            Referer: location.href,
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
        const data = await res.json();
        window.postMessage({ __biliPet: true, type: 'fetch_res', id, ok: true, data }, '*');
      } catch (err) {
        window.postMessage(
          {
            __biliPet: true,
            type: 'fetch_res',
            id,
            ok: false,
            error: String(err?.message || err),
          },
          '*'
        );
      }
    })();
  });
})();
