(() => {
  if (/\/video\/BV/i.test(location.pathname)) {
  }

  BiliActions?.watchPageScroll?.('browse');
  BiliActions?.watchVideoSelection?.();

  let nearBottomSent = false;
  window.addEventListener(
    'scroll',
    () => {
      const remain =
        document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
      if (remain < 400) {
        if (!nearBottomSent) {
          nearBottomSent = true;
          BiliActions?.emit?.('scroll_feed_end', {
            target: 'feed',
            remain,
            force: true,
          });
        }
      } else {
        nearBottomSent = false;
      }
    },
    { passive: true }
  );
})();
