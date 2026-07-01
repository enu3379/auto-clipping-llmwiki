importScripts("clipper.js");

const MENU_CLIP_PAGE = "llm-wiki-clip-page";
const AI_PROVENANCE_PREFIX = "llm-wiki-ai-provenance:";
const pendingDwell = new Map();
const aiProvenanceByTab = new Map();
const tabCommittedUrls = new Map();

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

function clearBadge(tabId) {
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text: "" });
}

function provenanceKey(tabId) {
  return `${AI_PROVENANCE_PREFIX}${tabId}`;
}

function isAiOriginUrl(url, settings) {
  return LlmWikiClipper.isClippableUrl(url || "")
    && LlmWikiClipper.matchesAnyPattern(url, settings.aiOriginDomains);
}

function buildAiProvenance(sourceUrl, method) {
  return {
    type: "ai-source",
    sourceUrl,
    method,
    ts: Date.now(),
  };
}

async function storeAiProvenance(tabId, provenance) {
  if (!tabId || !provenance) return;
  aiProvenanceByTab.set(tabId, provenance);
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [provenanceKey(tabId)]: provenance });
  }
}

async function getAiProvenance(tabId) {
  if (!tabId) return null;
  if (aiProvenanceByTab.has(tabId)) return aiProvenanceByTab.get(tabId);

  if (chrome.storage?.session) {
    const stored = await chrome.storage.session.get(provenanceKey(tabId));
    const provenance = stored[provenanceKey(tabId)] || null;
    if (provenance) aiProvenanceByTab.set(tabId, provenance);
    return provenance;
  }

  return null;
}

async function clearAiProvenance(tabId) {
  if (!tabId) return;
  aiProvenanceByTab.delete(tabId);
  if (chrome.storage?.session) {
    await chrome.storage.session.remove(provenanceKey(tabId));
  }
}

function showAiRecommendation(tabId) {
  setBadge(tabId, "AI", "#7c3aed", 0);
}

async function hasClipPermission(url) {
  const origin = LlmWikiClipper.getOrigin(url);
  if (!origin) return false;
  return await LlmWikiClipper.hasOriginPermission(origin)
    || await LlmWikiClipper.hasAllUrlsPermission();
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
    if (result?.duplicate) {
      setBadge(tab.id, "DUP", "#64748b");
    } else {
      setBadge(tab.id, "OK", "#16a34a");
    }
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
  const provenance = source === "popup" ? await getAiProvenance(tab.id) : null;
  const result = await clipTabWithFeedback(tab, {
    source: provenance ? "ai-source" : source,
    provenance,
  });
  if (result.ok && provenance) await clearAiProvenance(tab.id);
  return result;
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
  const provenance = await getAiProvenance(tabId);
  const aiCandidate = provenance
    && settings.aiSourceMode !== "off"
    && !isAiOriginUrl(tab.url, settings);

  if (await LlmWikiClipper.wasAutoClippedRecently(normalizedUrl, settings)) return;
  if (LlmWikiClipper.isBlacklistedUrl(tab.url, settings)) {
    clearBadge(tabId);
    return;
  }

  if (aiCandidate && settings.aiSourceMode === "recommend") {
    showAiRecommendation(tabId);
    return;
  }

  const trigger = getTrigger(settings, tab.url);
  const autoTrigger = aiCandidate && settings.aiSourceMode === "auto"
    ? "ai-source"
    : trigger;

  if (!await hasClipPermission(tab.url)) {
    if (aiCandidate) showAiRecommendation(tabId);
    return;
  }

  try {
    if (!aiCandidate) clearBadge(tabId);
    await scheduleDwellClip(tabId, tab, settings, autoTrigger, aiCandidate ? provenance : null);
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
  const result = await clipTabWithFeedback(tab, {
    source: pending.trigger,
    provenance: pending.provenance,
    markAutoHistory: true,
  });
  if (result.ok && pending.provenance) await clearAiProvenance(tab.id);
  return result;
}

async function markAiSourceTab(tabId, sourceUrl, method) {
  const settings = await LlmWikiClipper.getSettings();
  if (settings.aiSourceMode === "off") return;
  if (!isAiOriginUrl(sourceUrl, settings)) return;

  await storeAiProvenance(tabId, buildAiProvenance(sourceUrl, method));
}

async function detectCommittedNavigation(tabId, url, method) {
  const settings = await LlmWikiClipper.getSettings();
  const previousUrl = tabCommittedUrls.get(tabId);

  if (previousUrl && isAiOriginUrl(previousUrl, settings) && !isAiOriginUrl(url, settings)) {
    await storeAiProvenance(tabId, buildAiProvenance(previousUrl, method));
  } else if (isAiOriginUrl(url, settings)) {
    await clearAiProvenance(tabId);
  }

  tabCommittedUrls.set(tabId, url);
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
    (async () => {
      if (message.referrer) {
        await markAiSourceTab(sender.tab.id, message.referrer, "referrer");
      }
      await reevaluateTab(sender.tab.id);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message?.type === "llm-wiki-get-ai-provenance") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      sendResponse({ ok: true, provenance: tab?.id ? await getAiProvenance(tab.id) : null });
    })();
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
    detectCommittedNavigation(details.tabId, details.url, "history-state").then(() => {
      reevaluateTab(details.tabId);
    }).catch((err) => {
      console.debug("[LLM Wiki Clipper] AI source history detection failed:", err);
    });
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
    detectCommittedNavigation(details.tabId, details.url, "committed").catch((err) => {
      console.debug("[LLM Wiki Clipper] AI source navigation detection failed:", err);
    });
  }
});

chrome.webNavigation?.onCreatedNavigationTarget?.addListener((details) => {
  if (!details.sourceTabId || !details.tabId) return;

  chrome.tabs.get(details.sourceTabId, async (sourceTab) => {
    if (chrome.runtime.lastError) return;
    const sourceUrl = sourceTab?.url || "";
    if (!sourceUrl) return;
    try {
      await markAiSourceTab(details.tabId, sourceUrl, "created-navigation-target");
    } catch (err) {
      console.debug("[LLM Wiki Clipper] AI source target detection failed:", err);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingDwell.forEach((_value, key) => {
    if (key.startsWith(`${tabId}:`)) pendingDwell.delete(key);
  });
  tabCommittedUrls.delete(tabId);
  clearAiProvenance(tabId).catch((err) => {
    console.debug("[LLM Wiki Clipper] AI source cleanup failed:", err);
  });
});
