const statusBar = document.getElementById("statusBar");
const titleInput = document.getElementById("titleInput");
const urlPreview = document.getElementById("urlPreview");
const contentPreview = document.getElementById("contentPreview");
const clipBtn = document.getElementById("clipBtn");
const projectSelect = document.getElementById("projectSelect");
const autoClipSite = document.getElementById("autoClipSite");
const autoClipHint = document.getElementById("autoClipHint");
const sessionTagInput = document.getElementById("sessionTagInput");
const allowSiteBtn = document.getElementById("allowSiteBtn");
const blockSiteBtn = document.getElementById("blockSiteBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");

const clipper = globalThis.LlmWikiClipper;

let extractedPage = null;
let pageUrl = "";
let currentOrigin = "";
let currentTab = null;
let settings = null;
let isConnected = false;
let currentAiProvenance = null;

function setStatus(type, text) {
  statusBar.className = `status ${type}`;
  statusBar.textContent = text;
}

function selectedProjectPath() {
  return projectSelect.value || "";
}

function selectedProjectName() {
  return projectSelect.options[projectSelect.selectedIndex]?.textContent || "project";
}

function currentHostname() {
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return "";
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "AI chat";
  }
}

function renderProjects(projects) {
  projectSelect.innerHTML = "";

  if (!projects.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = isConnected ? "No projects" : "App not running";
    projectSelect.appendChild(opt);
    return;
  }

  const preferredPath = settings.defaultProjectPath
    || projects.find((project) => project.current)?.path
    || projects[0].path;

  for (const project of projects) {
    const opt = document.createElement("option");
    opt.value = project.path;
    opt.textContent = project.name + (project.current ? " (current)" : "");
    if (project.path === preferredPath) opt.selected = true;
    projectSelect.appendChild(opt);
  }
}

function previewText(page) {
  if (page.excerpt) {
    return `${page.excerpt}\n\n---\n\n${page.content}`;
  }
  return page.content;
}

async function loadConnectionState() {
  try {
    isConnected = await clipper.checkConnection(settings);
    setStatus("connected", "Connected to LLM Wiki");
    const projects = await clipper.loadProjects(settings);
    renderProjects(projects);
  } catch {
    isConnected = false;
    setStatus("disconnected", "LLM Wiki app is not running");
    renderProjects([]);
  }
}

async function extractContent() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      contentPreview.textContent = "No active tab";
      return;
    }

    currentTab = tab;
    pageUrl = tab.url || "";
    currentOrigin = clipper.getOrigin(pageUrl);
    titleInput.value = tab.title || "Untitled";
    urlPreview.textContent = pageUrl || "--";

    if (!clipper.isClippableUrl(pageUrl)) {
      contentPreview.textContent = "This page cannot be clipped.";
      clipBtn.disabled = true;
      await refreshAutoControls();
      return;
    }

    settings = await clipper.getSettings();
    if (clipper.isBlacklistedUrl(pageUrl, settings)) {
      contentPreview.textContent = "This page matches the blacklist and will not be clipped.";
      clipBtn.disabled = true;
      await refreshAutoControls();
      return;
    }

    extractedPage = await clipper.extractContentFromTab(tab.id, tab);
    titleInput.value = extractedPage.title;
    contentPreview.textContent = previewText(extractedPage);
    clipBtn.disabled = !isConnected || !selectedProjectPath();
    if (!isConnected) {
      clipBtn.textContent = "App not running - cannot save";
    }
  } catch (err) {
    extractedPage = null;
    contentPreview.textContent = `Error: ${err.message}`;
    clipBtn.disabled = true;
  } finally {
    await refreshAutoControls();
  }
}

async function sendClip() {
  const projectPath = selectedProjectPath();
  if (!projectPath) {
    setStatus("error", "Please select a project");
    return;
  }
  if (!extractedPage) {
    setStatus("error", "No extracted content to save");
    return;
  }

  clipBtn.disabled = true;
  setStatus("sending", "Sending to LLM Wiki...");

  try {
    settings = await clipper.getSettings();
    if (clipper.isBlacklistedUrl(pageUrl, settings)) {
      throw new Error("This page matches the blacklist");
    }

    const sessionTag = sessionTagInput.value.trim();
    settings = { ...settings, sessionTag };
    await clipper.saveSettings({
      defaultProjectPath: projectPath,
      sessionTag,
      sessionStartedAt: sessionTag ? settings.sessionStartedAt || Date.now() : null,
    });
    const clipContent = clipper.withClipMetadata(extractedPage.content, settings, {
      source: currentAiProvenance ? "ai-source" : "popup",
      provenance: currentAiProvenance,
    });
    const data = await clipper.sendClip({
      title: titleInput.value.trim() || extractedPage.title,
      url: clipper.normalizeUrl(pageUrl),
      content: clipContent,
      projectPath,
    }, settings);

    if (data.duplicate) {
      setStatus("success", `Already saved in ${selectedProjectName()}`);
      clipBtn.textContent = "Already clipped";
    } else {
      setStatus("success", `Saved to ${selectedProjectName()}`);
      clipBtn.textContent = "Clipped";
    }
    return data;
  } catch (err) {
    setStatus("error", `Error: ${err.message}`);
    clipBtn.disabled = false;
  }
}

async function refreshAutoControls() {
  settings = await clipper.getSettings();
  const projectPath = selectedProjectPath();
  currentAiProvenance = await getCurrentAiProvenance();

  if (!currentOrigin || !clipper.isClippableUrl(pageUrl)) {
    autoClipSite.disabled = true;
    autoClipSite.checked = false;
    allowSiteBtn.disabled = true;
    blockSiteBtn.disabled = true;
    autoClipHint.textContent = "Auto-clip is available on regular web pages.";
    return;
  }

  const isBlocked = clipper.isBlacklistedUrl(pageUrl, settings);
  const isAllowed = clipper.matchesAnyPattern(pageUrl, settings.whitelist);
  allowSiteBtn.disabled = !currentHostname() || isAllowed || isBlocked;
  blockSiteBtn.disabled = !currentHostname() || isBlocked;

  if (isBlocked) {
    autoClipSite.disabled = true;
    autoClipSite.checked = false;
    autoClipHint.textContent = `${currentHostname()} is blacklisted and will not be clipped.`;
    return;
  }

  if (!projectPath) {
    autoClipSite.disabled = true;
    autoClipSite.checked = false;
    autoClipHint.textContent = "Select a project before enabling auto-clip.";
    return;
  }

  autoClipSite.disabled = false;
  const originEnabled = settings.autoClipOrigins.includes(currentOrigin);
  const hasPermission = await clipper.hasOriginPermission(currentOrigin);
  autoClipSite.checked = settings.autoClipEnabled && originEnabled && hasPermission;

  if (autoClipSite.checked) {
    autoClipHint.textContent = `Future pages on ${currentOrigin} will be clipped to ${selectedProjectName()}.`;
  } else if (currentAiProvenance && settings.aiSourceMode === "recommend") {
    autoClipHint.textContent = `Recommended: this page was opened from ${hostnameFromUrl(currentAiProvenance.sourceUrl)}.`;
  } else if (originEnabled && !hasPermission) {
    autoClipHint.textContent = `Permission is missing for ${currentOrigin}. Re-enable auto-clip to grant it.`;
  } else {
    autoClipHint.textContent = `Enable to clip future pages on ${currentOrigin} automatically.`;
  }
}

async function getCurrentAiProvenance() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "llm-wiki-get-ai-provenance" });
    return response?.provenance || null;
  } catch {
    return null;
  }
}

async function toggleAutoClipForSite() {
  const projectPath = selectedProjectPath();
  if (!currentOrigin || !projectPath) {
    autoClipSite.checked = false;
    await refreshAutoControls();
    return;
  }

  settings = await clipper.getSettings();

  if (autoClipSite.checked) {
    const granted = await clipper.requestOriginPermission(currentOrigin);
    if (!granted) {
      autoClipSite.checked = false;
      autoClipHint.textContent = `Chrome did not grant access to ${currentOrigin}.`;
      return;
    }

    const origins = Array.from(new Set([...settings.autoClipOrigins, currentOrigin]));
    await clipper.saveSettings({
      autoClipEnabled: true,
      autoClipOrigins: origins,
      defaultProjectPath: projectPath,
    });
  } else {
    const origins = settings.autoClipOrigins.filter((origin) => origin !== currentOrigin);
    await clipper.saveSettings({
      autoClipOrigins: origins,
      autoClipEnabled: origins.length > 0 ? settings.autoClipEnabled : false,
    });
  }

  await refreshAutoControls();
}

async function addCurrentSiteToWhitelist() {
  const host = currentHostname();
  if (!host) return;

  settings = await clipper.getSettings();
  const granted = await clipper.requestOriginPermission(currentOrigin);
  if (!granted) {
    autoClipHint.textContent = `Chrome did not grant access to ${host}.`;
    return;
  }

  await clipper.saveSettings({
    autoClipEnabled: true,
    whitelist: clipper.parsePatternList([...(settings.whitelist || []), host]),
  });
  autoClipHint.textContent = `${host} added to whitelist.`;
  await refreshAutoControls();
}

async function addCurrentSiteToBlacklist() {
  const host = currentHostname();
  if (!host) return;

  settings = await clipper.getSettings();
  const origins = (settings.autoClipOrigins || []).filter((origin) => origin !== currentOrigin);
  await clipper.saveSettings({
    blacklist: clipper.parsePatternList([...(settings.blacklist || []), host]),
    autoClipOrigins: origins,
  });
  extractedPage = null;
  clipBtn.disabled = true;
  contentPreview.textContent = "This page matches the blacklist and will not be clipped.";
  autoClipHint.textContent = `${host} added to blacklist.`;
  await refreshAutoControls();
}

function openOptionsPage() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  }
}

function resizePreview() {
  const totalHeight = 560;
  const preview = document.getElementById("contentPreview");
  if (!preview) return;

  const previewRect = preview.getBoundingClientRect();
  const bottomSpace = totalHeight - previewRect.top - 60;
  const maxHeight = Math.max(90, Math.min(240, bottomSpace));
  preview.style.maxHeight = `${maxHeight}px`;
}

clipBtn.addEventListener("click", sendClip);
autoClipSite.addEventListener("change", toggleAutoClipForSite);
allowSiteBtn.addEventListener("click", addCurrentSiteToWhitelist);
blockSiteBtn.addEventListener("click", addCurrentSiteToBlacklist);
openOptionsBtn.addEventListener("click", openOptionsPage);
sessionTagInput.addEventListener("change", async () => {
  await clipper.saveSettings({
    sessionTag: sessionTagInput.value.trim(),
    sessionStartedAt: sessionTagInput.value.trim() ? Date.now() : null,
  });
  settings = await clipper.getSettings();
});
projectSelect.addEventListener("change", async () => {
  const projectPath = selectedProjectPath();
  if (projectPath) await clipper.saveSettings({ defaultProjectPath: projectPath });
  await refreshAutoControls();
});

(async () => {
  settings = await clipper.getSettings();
  sessionTagInput.value = settings.sessionTag || "";
  await loadConnectionState();
  await extractContent();
  setTimeout(resizePreview, 100);
})();
