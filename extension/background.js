importScripts("clipper.js");

const MENU_CLIP_PAGE = "llm-wiki-clip-page";
const pendingDwell = new Map();

function dwellKey(tabId, normalizedUrl) {
  return `${tabId}:${normalizedUrl}`;
}

function setBadge(tabId, text, color, timeoutMs = 2500) {
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  if (timeoutMs > 0) {
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), timeoutMs);
  }
}

async function clipTabWithFeedback(tab, options = {}) {
  try {
    const settings = await LlmWikiClipper.getSettings();
    const normalizedUrl = LlmWikiClipper.normalizeUrl(tab.url || "");

    if (LlmWikiClipper.isBlacklistedUrl(tab.url, settings)) {
      setBadge(tab.id, "SKIP", "#64748b");
      return { ok: false, skipped: true, reason: "blacklist" };
    }
    if (options.markAutoHistory && await LlmWikiClipper.wasAutoClippedRecently(normalizedUrl, settings)) {
      setBadge(tab.id, "DUP", "#64748b");
      return { ok: false, skipped: true, reason: "duplicate" };
    }

    const result = await LlmWikiClipper.clipTab(tab, options);
    setBadge(tab.id, "OK", "#16a34a");
    return { ok: true, result };
  } catch (err) {
    console.error("[LLM Wiki Clipper] Clip failed:", err);
    setBadge(tab?.id, "ERR", "#dc2626");
    return { ok: false, error: err.message || String(err) };
  }
}

async function clipActiveTab(source) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };
  return clipTabWithFeedback(tab, { source });
}

function getDwellMs(settings, trigger) {
  if (trigger === "whitelist") {
    return Number(settings.whitelistDwellMs)
      || Number(settings.autoClipDelayMs)
      || LlmWikiClipper.DEFAULT_SETTINGS.whitelistDwellMs;
  }
  if (trigger === "ai-source") {
    return Number(settings.aiSourceDwellMs) || LlmWikiClipper.DEFAULT_SETTINGS.aiSourceDwellMs;
  }
  return Number(settings.dwellMs) || LlmWikiClipper.DEFAULT_SETTINGS.dwellMs;
}

function getTrigger(settings, url) {
  const origin = LlmWikiClipper.getOrigin(url);
  const originWhitelisted = origin && settings.autoClipOrigins.includes(origin);
  const patternWhitelisted = LlmWikiClipper.matchesAnyPattern(url, settings.whitelist);
  return originWhitelisted || patternWhitelisted ? "whitelist" : "dwell";
}

async function injectDwellScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-script.js"],
  });
}

async function scheduleDwellClip(tabId, tab, settings, trigger, provenance) {
  const normalizedUrl = LlmWikiClipper.normalizeUrl(tab.url);
  const key = dwellKey(tabId, normalizedUrl);
  const requiredDwellMs = getDwellMs(settings, trigger);

  pendingDwell.set(key, {
    tabId,
    normalizedUrl,
    originalUrl: tab.url,
    trigger,
    provenance,
    requestedAt: Date.now(),
  });

  await injectDwellScript(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: "llm-wiki-watch-dwell",
    normalizedUrl,
    url: tab.url,
    requiredDwellMs,
    trigger,
    provenance,
  });
}

async function maybeAutoClip(tabId, tab) {
  if (!tab?.url || !LlmWikiClipper.isClippableUrl(tab.url)) return;

  const settings = await LlmWikiClipper.getSettings();
  if (!settings.autoClipEnabled) return;

  const normalizedUrl = LlmWikiClipper.normalizeUrl(tab.url);
  if (await LlmWikiClipper.wasAutoClippedRecently(normalizedUrl, settings)) return;
  if (LlmWikiClipper.isBlacklistedUrl(tab.url, settings)) return;

  const origin = LlmWikiClipper.getOrigin(tab.url);
  if (!origin || !await LlmWikiClipper.hasOriginPermission(origin)) return;

  const trigger = getTrigger(settings, tab.url);
  try {
    await scheduleDwellClip(tabId, tab, settings, trigger, null);
  } catch (err) {
    console.debug("[LLM Wiki Clipper] Could not schedule dwell clip:", err);
  }
}

async function reevaluateTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await maybeAutoClip(tabId, tab);
  } catch (err) {
    console.debug("[LLM Wiki Clipper] Could not reevaluate tab:", err);
  }
}

async function handleDwellMet(message, sender) {
  const tab = sender.tab;
  if (!tab?.id || !tab.url) return { ok: false, error: "No sender tab" };

  const normalizedUrl = LlmWikiClipper.normalizeUrl(message.normalizedUrl || tab.url);
  const key = dwellKey(tab.id, normalizedUrl);
  const pending = pendingDwell.get(key);
  if (!pending) return { ok: false, skipped: true, reason: "not-pending" };
  if (LlmWikiClipper.normalizeUrl(tab.url) !== normalizedUrl) {
    pendingDwell.delete(key);
    return { ok: false, skipped: true, reason: "url-changed" };
  }

  pendingDwell.delete(key);
  return clipTabWithFeedback(tab, {
    source: pending.trigger,
    provenance: pending.provenance,
    markAutoHistory: true,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_CLIP_PAGE,
    title: "Clip page to LLM Wiki",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_CLIP_PAGE && tab?.id) {
    clipTabWithFeedback(tab, { source: "context-menu" });
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "clip-current-page") {
    clipActiveTab("shortcut");
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "clip-active-tab") {
    clipActiveTab("popup").then(sendResponse);
    return true;
  }
  if (message?.type === "llm-wiki-dwell-met") {
    handleDwellMet(message, sender).then(sendResponse);
    return true;
  }
  if (message?.type === "llm-wiki-url-changed" && sender.tab?.id) {
    reevaluateTab(sender.tab.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    maybeAutoClip(tabId, tab).catch((err) => {
      console.debug("[LLM Wiki Clipper] Auto-clip evaluation failed:", err);
    });
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  reevaluateTab(tabId);
});

chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
  if (details.frameId === 0) {
    reevaluateTab(details.tabId);
  }
});

chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId === 0) {
    const normalizedUrl = LlmWikiClipper.normalizeUrl(details.url || "");
    for (const key of Array.from(pendingDwell.keys())) {
      if (key.startsWith(`${details.tabId}:`) && key !== dwellKey(details.tabId, normalizedUrl)) {
        pendingDwell.delete(key);
      }
    }
  }
});
