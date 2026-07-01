(() => {
  const API_URLS = ["http://127.0.0.1:19827", "http://localhost:19827"];
  const AUTO_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_HISTORY_ENTRIES = 500;

  const DEFAULT_SETTINGS = {
    apiUrl: API_URLS[0],
    defaultProjectPath: "",
    autoClipEnabled: false,
    autoClipOrigins: [],
    minContentLength: 200,
    autoClipDelayMs: 1500,
  };

  function canUseStorage() {
    return Boolean(globalThis.chrome?.storage?.local);
  }

  async function getSettings() {
    if (!canUseStorage()) return { ...DEFAULT_SETTINGS };
    const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      autoClipOrigins: Array.isArray(stored.autoClipOrigins) ? stored.autoClipOrigins : [],
    };
  }

  async function saveSettings(patch) {
    if (!canUseStorage()) return;
    await chrome.storage.local.set(patch);
  }

  async function clipFetch(path, options = {}, settings) {
    const method = String(options.method || "GET").toUpperCase();
    const currentApiUrl = settings?.apiUrl || (await getSettings()).apiUrl || API_URLS[0];
    const urls = method === "GET"
      ? [currentApiUrl, ...API_URLS.filter((url) => url !== currentApiUrl)]
      : [currentApiUrl];
    let lastError;

    for (const baseUrl of urls) {
      try {
        const res = await fetch(`${baseUrl}${path}`, options);
        if (method === "GET" && baseUrl !== currentApiUrl) {
          if (settings) settings.apiUrl = baseUrl;
          await saveSettings({ apiUrl: baseUrl });
        }
        return res;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("Unable to connect to LLM Wiki");
  }

  async function checkConnection(settings) {
    const res = await clipFetch("/status", { method: "GET" }, settings);
    const data = await res.json();
    return Boolean(data.ok);
  }

  async function loadProjects(settings) {
    try {
      const res = await clipFetch("/projects", { method: "GET" }, settings);
      const data = await res.json();
      if (data.ok && Array.isArray(data.projects) && data.projects.length > 0) {
        return data.projects;
      }
    } catch {}

    const res = await clipFetch("/project", { method: "GET" }, settings);
    const data = await res.json();
    if (data.ok && data.path) {
      const name = data.path.replace(/\\/g, "/").split("/").pop() || data.path;
      return [{ name, path: data.path, current: true }];
    }

    return [];
  }

  async function resolveProjectPath(settings) {
    const projects = await loadProjects(settings);
    if (settings?.defaultProjectPath) {
      const selected = projects.find((project) => project.path === settings.defaultProjectPath);
      if (selected) return selected.path;
    }

    const current = projects.find((project) => project.current);
    return current?.path || projects[0]?.path || "";
  }

  function isClippableUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function getOrigin(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin;
    } catch {
      return "";
    }
  }

  function originToPermissionPattern(origin) {
    try {
      const parsed = new URL(origin);
      return `${parsed.protocol}//${parsed.host}/*`;
    } catch {
      return "";
    }
  }

  async function hasOriginPermission(origin) {
    const pattern = originToPermissionPattern(origin);
    if (!pattern || !globalThis.chrome?.permissions?.contains) return false;
    return chrome.permissions.contains({ origins: [pattern] });
  }

  async function requestOriginPermission(origin) {
    const pattern = originToPermissionPattern(origin);
    if (!pattern || !globalThis.chrome?.permissions?.request) return false;
    return chrome.permissions.request({ origins: [pattern] });
  }

  async function extractContentFromTab(tabId, tab = {}) {
    if (!tabId) throw new Error("No active tab");
    if (!isClippableUrl(tab.url || "")) {
      throw new Error("This page cannot be clipped");
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["Readability.js", "Turndown.js"],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function extractFallback() {
          const clone = document.body.cloneNode(true);
          ["script", "style", "nav", "header", "footer", ".sidebar", ".ad", ".comments"]
            .forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));

          return clone.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join("\n\n")
            .slice(0, 50000);
        }

        try {
          const documentClone = document.cloneNode(true);
          const reader = new window.Readability(documentClone);
          const article = reader.parse();

          if (!article || !article.content) {
            return { fallback: true, content: extractFallback() };
          }

          const turndown = new window.TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
          });

          turndown.addRule("tableCell", {
            filter: ["th", "td"],
            replacement: (content) => ` ${content.trim()} |`,
          });
          turndown.addRule("tableRow", {
            filter: "tr",
            replacement: (content) => `|${content}\n`,
          });
          turndown.addRule("table", {
            filter: "table",
            replacement: (content) => {
              const lines = content.trim().split("\n");
              if (lines.length > 0) {
                const cols = (lines[0].match(/\|/g) || []).length - 1;
                const separator = "|" + " --- |".repeat(cols);
                lines.splice(1, 0, separator);
              }
              return "\n\n" + lines.join("\n") + "\n\n";
            },
          });
          turndown.addRule("removeSmallImages", {
            filter: (node) => {
              if (node.nodeName !== "IMG") return false;
              const width = parseInt(node.getAttribute("width") || "999", 10);
              const height = parseInt(node.getAttribute("height") || "999", 10);
              return width < 10 || height < 10;
            },
            replacement: () => "",
          });

          return {
            title: article.title || document.title,
            content: turndown.turndown(article.content),
            excerpt: article.excerpt || "",
            siteName: article.siteName || "",
            length: article.length || 0,
          };
        } catch (err) {
          try {
            return { fallback: true, content: extractFallback(), error: err.message };
          } catch (fallbackErr) {
            return { error: fallbackErr.message || err.message };
          }
        }
      },
    });

    const result = results?.[0]?.result;
    if (!result || result.error && !result.content) {
      throw new Error(result?.error || "Failed to extract content");
    }

    const title = result.title && result.title.length > 5 ? result.title : tab.title || "Untitled";
    return {
      title,
      url: tab.url || "",
      content: result.content || "",
      excerpt: result.excerpt || "",
      siteName: result.siteName || "",
      length: result.length || 0,
      fallback: Boolean(result.fallback),
      error: result.error || "",
    };
  }

  async function sendClip({ title, url, content, projectPath }, settings) {
    const res = await clipFetch("/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, url, content, projectPath }),
    }, settings);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Clip failed");
    return data;
  }

  async function getAutoHistory() {
    if (!canUseStorage()) return {};
    const stored = await chrome.storage.local.get("autoClipHistory");
    return stored.autoClipHistory && typeof stored.autoClipHistory === "object"
      ? stored.autoClipHistory
      : {};
  }

  async function wasAutoClippedRecently(url) {
    const history = await getAutoHistory();
    const clippedAt = history[url];
    return typeof clippedAt === "number" && Date.now() - clippedAt < AUTO_HISTORY_TTL_MS;
  }

  async function markAutoClipped(url) {
    if (!canUseStorage() || !url) return;
    const now = Date.now();
    const history = await getAutoHistory();
    const freshEntries = Object.entries(history)
      .filter(([, clippedAt]) => typeof clippedAt === "number" && now - clippedAt < AUTO_HISTORY_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HISTORY_ENTRIES - 1);
    const nextHistory = Object.fromEntries(freshEntries);
    nextHistory[url] = now;
    await chrome.storage.local.set({ autoClipHistory: nextHistory });
  }

  async function clipTab(tab, options = {}) {
    const settings = await getSettings();
    const projectPath = options.projectPath || settings.defaultProjectPath || await resolveProjectPath(settings);
    if (!projectPath) throw new Error("No LLM Wiki project is available");

    const extracted = await extractContentFromTab(tab.id, tab);
    const minLength = Number(settings.minContentLength) || DEFAULT_SETTINGS.minContentLength;
    if (extracted.content.trim().length < minLength) {
      throw new Error("Extracted content is too short");
    }

    const result = await sendClip({
      title: extracted.title,
      url: extracted.url,
      content: extracted.content,
      projectPath,
    }, settings);

    await saveSettings({ defaultProjectPath: projectPath });
    if (options.markAutoHistory) await markAutoClipped(extracted.url);

    return {
      ...result,
      title: extracted.title,
      url: extracted.url,
      projectPath,
    };
  }

  globalThis.LlmWikiClipper = {
    API_URLS,
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    clipFetch,
    checkConnection,
    loadProjects,
    resolveProjectPath,
    isClippableUrl,
    getOrigin,
    hasOriginPermission,
    requestOriginPermission,
    extractContentFromTab,
    sendClip,
    wasAutoClippedRecently,
    markAutoClipped,
    clipTab,
  };
})();
