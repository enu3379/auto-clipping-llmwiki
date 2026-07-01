(() => {
  if (globalThis.__llmWikiDwellScriptInstalled) return;
  globalThis.__llmWikiDwellScriptInstalled = true;

  let activeWatch = null;
  let visibleSince = 0;
  let accumulatedMs = 0;
  let timerId = null;
  let lastUrl = location.href;

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function isVisible() {
    return document.visibilityState === "visible";
  }

  function now() {
    return Date.now();
  }

  function currentElapsedMs() {
    if (!activeWatch) return 0;
    if (!isVisible() || !visibleSince) return accumulatedMs;
    return accumulatedMs + now() - visibleSince;
  }

  function pauseVisibleTime() {
    if (!visibleSince) return;
    accumulatedMs += now() - visibleSince;
    visibleSince = 0;
  }

  function armTimer() {
    clearTimer();
    if (!activeWatch || !isVisible()) return;

    const remaining = Math.max(0, activeWatch.requiredDwellMs - currentElapsedMs());
    timerId = setTimeout(finishIfReady, remaining);
  }

  function finishIfReady() {
    if (!activeWatch) return;
    if (currentElapsedMs() < activeWatch.requiredDwellMs) {
      armTimer();
      return;
    }

    const completed = activeWatch;
    activeWatch = null;
    clearTimer();

    chrome.runtime.sendMessage({
      type: "llm-wiki-dwell-met",
      normalizedUrl: completed.normalizedUrl,
      url: completed.url,
      trigger: completed.trigger,
    });
  }

  function startWatch(message) {
    clearTimer();
    activeWatch = {
      normalizedUrl: message.normalizedUrl,
      url: message.url,
      requiredDwellMs: Math.max(0, Number(message.requiredDwellMs) || 0),
      trigger: message.trigger || "dwell",
    };
    accumulatedMs = 0;
    visibleSince = isVisible() ? now() : 0;
    armTimer();
  }

  function stopWatch() {
    activeWatch = null;
    accumulatedMs = 0;
    visibleSince = 0;
    clearTimer();
  }

  function handleVisibilityChange() {
    if (!activeWatch) return;
    if (isVisible()) {
      visibleSince = now();
      armTimer();
    } else {
      pauseVisibleTime();
      clearTimer();
    }
  }

  function notifyUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    stopWatch();
    chrome.runtime.sendMessage({
      type: "llm-wiki-url-changed",
      url: lastUrl,
      referrer: document.referrer || "",
    });
  }

  function patchHistoryMethod(name) {
    const original = history[name];
    history[name] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      setTimeout(notifyUrlChange, 0);
      return result;
    };
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("popstate", () => setTimeout(notifyUrlChange, 0));
  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "llm-wiki-watch-dwell") {
      startWatch(message);
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
