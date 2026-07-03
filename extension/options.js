const whitelistInput = document.getElementById("whitelistInput");
const blacklistInput = document.getElementById("blacklistInput");
const whitelistDwellInput = document.getElementById("whitelistDwellInput");
const dwellInput = document.getElementById("dwellInput");
const minContentInput = document.getElementById("minContentInput");
const aiModeInput = document.getElementById("aiModeInput");
const aiOriginsInput = document.getElementById("aiOriginsInput");
const saveBtn = document.getElementById("saveBtn");
const reloadBtn = document.getElementById("reloadBtn");
const statusEl = document.getElementById("status");

const clipper = globalThis.LlmWikiClipper;

function setStatus(type, text) {
  statusEl.className = `status ${type || ""}`;
  statusEl.textContent = text || "";
}

function numberValue(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function loadSettings() {
  const settings = await clipper.getSettings();
  whitelistInput.value = clipper.formatPatternList(settings.whitelist);
  blacklistInput.value = clipper.formatPatternList(settings.blacklist);
  whitelistDwellInput.value = String(settings.whitelistDwellMs);
  dwellInput.value = String(settings.dwellMs);
  minContentInput.value = String(settings.minContentLength);
  aiModeInput.value = settings.aiSourceMode || "recommend";
  aiOriginsInput.value = clipper.formatPatternList(settings.aiOriginDomains);
  setStatus("", "");
}

async function saveSettings() {
  saveBtn.disabled = true;
  setStatus("", "Saving...");

  try {
    const current = await clipper.getSettings();
    const whitelist = clipper.parsePatternList(whitelistInput.value);
    const blacklist = clipper.parsePatternList(blacklistInput.value);
    const aiOriginDomains = clipper.parsePatternList(aiOriginsInput.value);
    const aiSourceMode = aiModeInput.value || "recommend";
    const aiClickDwellMs = numberValue(dwellInput, current.dwellMs || current.aiSourceDwellMs);
    const autoClipOrigins = Array.isArray(current.autoClipOrigins) ? current.autoClipOrigins : [];

    const permissionResult = await clipper.requestPatternPermissions(whitelist);
    if (!permissionResult.granted && permissionResult.origins.length > 0) {
      setStatus("warn", "Saved lists, but Chrome did not grant all whitelist permissions. Those sites will not auto-clip until permission is granted.");
    }

    const aiAutoPermissionGranted = aiSourceMode === "auto"
      ? await clipper.requestAllUrlsPermission()
      : true;

    await clipper.saveSettings({
      whitelist,
      blacklist,
      whitelistDwellMs: numberValue(whitelistDwellInput, current.whitelistDwellMs),
      dwellMs: aiClickDwellMs,
      minContentLength: numberValue(minContentInput, current.minContentLength),
      aiOriginDomains,
      aiSourceMode,
      aiSourceDwellMs: aiClickDwellMs,
      autoClipEnabled: autoClipOrigins.length > 0 || whitelist.length > 0 || aiSourceMode === "auto",
    });

    const unsupported = permissionResult.unsupported || [];
    if (aiSourceMode === "auto" && !aiAutoPermissionGranted) {
      setStatus("warn", "Saved. AI source auto mode is enabled, but Chrome did not grant full site access; AI links will fall back to recommendation badges.");
    } else if (unsupported.length > 0) {
      setStatus("warn", `Saved. Some wildcard patterns need manual site permission before they can auto-clip: ${unsupported.join(", ")}`);
    } else if (permissionResult.granted || permissionResult.origins.length === 0) {
      setStatus("ok", "Settings saved.");
    }
  } catch (err) {
    setStatus("error", `Error: ${err.message || String(err)}`);
  } finally {
    saveBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", saveSettings);
reloadBtn.addEventListener("click", loadSettings);

loadSettings().catch((err) => {
  setStatus("error", `Error: ${err.message || String(err)}`);
});
