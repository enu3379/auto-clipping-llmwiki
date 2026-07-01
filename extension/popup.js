const statusBar = document.getElementById("statusBar");
const titleInput = document.getElementById("titleInput");
const urlPreview = document.getElementById("urlPreview");
const contentPreview = document.getElementById("contentPreview");
const clipBtn = document.getElementById("clipBtn");
const projectSelect = document.getElementById("projectSelect");
const autoClipSite = document.getElementById("autoClipSite");
const autoClipHint = document.getElementById("autoClipHint");
const sessionTagInput = document.getElementById("sessionTagInput");

const clipper = globalThis.LlmWikiClipper;

let extractedPage = null;
let pageUrl = "";
let currentOrigin = "";
let currentTab = null;
let settings = null;
let isConnected = false;

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
    const sessionTag = sessionTagInput.value.trim();
    settings = { ...settings, sessionTag };
    await clipper.saveSettings({
      defaultProjectPath: projectPath,
      sessionTag,
      sessionStartedAt: sessionTag ? settings.sessionStartedAt || Date.now() : null,
    });
    const clipContent = clipper.withClipMetadata(extractedPage.content, settings, {
      source: "popup",
    });
    const data = await clipper.sendClip({
      title: titleInput.value.trim() || extractedPage.title,
      url: clipper.normalizeUrl(pageUrl),
      content: clipContent,
      projectPath,
    }, settings);

    setStatus("success", `Saved to ${selectedProjectName()}`);
    clipBtn.textContent = "Clipped";
    return data;
  } catch (err) {
    setStatus("error", `Error: ${err.message}`);
    clipBtn.disabled = false;
  }
}

async function refreshAutoControls() {
  settings = await clipper.getSettings();
  const projectPath = selectedProjectPath();

  if (!currentOrigin || !clipper.isClippableUrl(pageUrl)) {
    autoClipSite.disabled = true;
    autoClipSite.checked = false;
    autoClipHint.textContent = "Auto-clip is available on regular web pages.";
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
  } else if (originEnabled && !hasPermission) {
    autoClipHint.textContent = `Permission is missing for ${currentOrigin}. Re-enable auto-clip to grant it.`;
  } else {
    autoClipHint.textContent = `Enable to clip future pages on ${currentOrigin} automatically.`;
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
