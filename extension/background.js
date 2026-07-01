importScripts("clipper.js");

const MENU_CLIP_PAGE = "llm-wiki-clip-page";
const pendingAutoClips = new Set();

function setBadge(tabId, text, color) {
  if (!tabId) return;
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: "" }), 2500);
}

async function clipTabWithFeedback(tab, options = {}) {
  try {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "clip-active-tab") {
    clipActiveTab("popup").then(sendResponse);
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;
  maybeAutoClip(tabId, tab);
});

async function maybeAutoClip(tabId, tab) {
  const settings = await LlmWikiClipper.getSettings();
  if (!settings.autoClipEnabled) return;
  if (!LlmWikiClipper.isClippableUrl(tab.url)) return;

  const origin = LlmWikiClipper.getOrigin(tab.url);
  if (!origin || !settings.autoClipOrigins.includes(origin)) return;
  if (!await LlmWikiClipper.hasOriginPermission(origin)) return;
  if (await LlmWikiClipper.wasAutoClippedRecently(tab.url)) return;

  const pendingKey = `${tabId}:${tab.url}`;
  if (pendingAutoClips.has(pendingKey)) return;
  pendingAutoClips.add(pendingKey);

  const delayMs = Number(settings.autoClipDelayMs) || LlmWikiClipper.DEFAULT_SETTINGS.autoClipDelayMs;
  setTimeout(async () => {
    try {
      const latestTab = await chrome.tabs.get(tabId);
      if (latestTab.url !== tab.url) return;
      await clipTabWithFeedback(latestTab, {
        source: "auto",
        markAutoHistory: true,
      });
    } catch (err) {
      console.error("[LLM Wiki Clipper] Auto-clip failed:", err);
    } finally {
      pendingAutoClips.delete(pendingKey);
    }
  }, delayMs);
}
