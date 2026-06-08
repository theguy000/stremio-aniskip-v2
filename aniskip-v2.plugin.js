/**
 * @name AniSkip v2
 * @description Skip anime openings, endings, and recaps automatically or with a popup using AniSkip v2 API. Supports IMDb and Kitsu metadata with season-aware MAL ID resolution via Jikan's relation chain.
 * @author theguy000
 * @version 1.0.0
 */

(function () {
  // State
  let activeSegments = [];
  let popupElement = null;
  let currentDuration = 0;
  let currentTime = 0;
  let ipcInitialized = false;
  let unlistenFn = null;
  let playerPollInterval = null;
  let playbackMonitorInterval = null;
  let currentEpisodeKey = null;
  let autoSkipEnabled = false;

  const SKIP_TYPE_LABELS = { op: "Opening", ed: "Ending", recap: "Recap" };
  const PLUGIN_NAME = "aniskip-v2";

  // --- Settings ---

  function normalizeToggle(value) {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return false;
  }

  async function registerPluginSettings() {
    if (typeof StremioEnhancedAPI === "undefined") return;

    try {
      await StremioEnhancedAPI.registerSettings([
        {
          key: "autoSkip",
          type: "toggle",
          label: "Auto Skip",
          description: "Automatically skip openings, endings, and recaps without showing a button.",
          defaultValue: false
        }
      ]);
    } catch {}
  }

  async function loadSettings() {
    if (typeof StremioEnhancedAPI === "undefined") return;

    try {
      const val = await StremioEnhancedAPI.getSetting("autoSkip");
      autoSkipEnabled = normalizeToggle(val);
    } catch {}
  }

  function listenForSettingsChanges() {
    if (typeof StremioEnhancedAPI === "undefined") return;
    if (typeof StremioEnhancedAPI.onSettingsSaved !== "function") return;

    StremioEnhancedAPI.onSettingsSaved(function (values) {
      if (values.autoSkip !== undefined) {
        autoSkipEnabled = normalizeToggle(values.autoSkip);
      }
    });
  }

  // Inject CSS for popup and seekbar marks
  const style = document.createElement("style");
  style.textContent = `
    .aniskip-v2-popup {
      position: absolute;
      bottom: 125px;
      right: 24px;
      z-index: 10000;
      background: #e5c158;
      border: none;
      border-radius: 20px;
      padding: 8px 16px;
      font-family: 'Outfit', 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #0c0c14;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .aniskip-v2-popup:hover {
      background: #f3d273;
    }
    .aniskip-timeline-mark {
      position: absolute;
      background: #e5c158;
      height: var(--track-size, 4px);
      top: 50%;
      transform: translateY(-50%);
      border-radius: 2px;
      pointer-events: none;
      z-index: 1;
    }
  `;
  document.head.appendChild(style);

  // --- Helpers ---

  function removePopup() {
    if (popupElement) {
      popupElement.remove();
      popupElement = null;
    }
  }

  function parsePayload(raw) {
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return null;
    }
  }

  function isOnPlayerPage() {
    return location.hash.startsWith("#/player");
  }

  function pollElement(selector, callback, maxAttempts = 30) {
    let attempts = 0;
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        callback(el);
      } else if (++attempts >= maxAttempts) {
        clearInterval(interval);
      }
    }, 1000);
  }

  function formatTime(seconds) {
    if (seconds == null || isNaN(seconds)) return "00:00";
    const m = Math.floor(seconds / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  // Evaluate JS in main page context to bypass content-script sandboxing
  function _eval(js) {
    return new Promise((resolve) => {
      const eventName = "aniskip-v2-eval";
      const script = document.createElement("script");
      window.addEventListener(eventName, (e) => {
        script.remove();
        resolve(e.detail);
      }, { once: true });
      script.textContent = `
        (async () => {
          try {
            const res = ${js};
            const value = res instanceof Promise ? await res : res;
            window.dispatchEvent(new CustomEvent('${eventName}', { detail: value }));
          } catch (err) {
            window.dispatchEvent(new CustomEvent('${eventName}', { detail: null }));
          }
        })();`;
      document.head.appendChild(script);
    });
  }

  // --- MPV IPC ---

  function handleMpvIpcMessage(payload) {
    const args = payload?.args;
    if (!Array.isArray(args)) return;

    if (args[0] === "mpv-prop-change") {
      const prop = args[1];
      if (!prop) return;

      if (prop.name === "duration") {
        const val = Number(prop.data);
        if (val > 0 && !isNaN(val)) {
          currentDuration = val;
        }
      } else if (prop.name === "time-pos") {
        const val = Number(prop.data);
        if (!isNaN(val)) currentTime = val;
      }
    } else if (args[0] === "mpv-event-ended") {
      currentTime = 0;
      currentDuration = 0;
    }
  }

  function initMpvIpcListener() {
    if (ipcInitialized) return;

    const host = window.StremioLightningHost;
    if (host && typeof host.listen === "function") {
      host.listen("shell-transport-message", (event) => {
        const payload = parsePayload(event.payload);
        if (payload) handleMpvIpcMessage(payload);
      }).then(unlisten => {
        unlistenFn = unlisten;
      });
      ipcInitialized = true;
    } else if (window.chrome?.webview?.addEventListener) {
      window.chrome.webview.addEventListener("message", (event) => {
        const payload = parsePayload(event.data);
        if (payload) handleMpvIpcMessage(payload);
      });
      ipcInitialized = true;
    }
  }

  // --- API ---

  function parsePositiveInt(value) {
    const number = parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function pickArmMALId(data, seasonNumber) {
    if (!Array.isArray(data)) {
      return parsePositiveInt(data?.myanimelist);
    }

    const normalizedSeasonNumber = Number.isInteger(seasonNumber) && seasonNumber > 0 ? seasonNumber : null;
    const seasonFieldMatch = normalizedSeasonNumber
      ? data.find(item => parsePositiveInt(item?.["thetvdb-season"]) === normalizedSeasonNumber)
      : null;
    const fieldMatch = parsePositiveInt(seasonFieldMatch?.myanimelist);
    if (fieldMatch) return fieldMatch;

    const seasonIndex = normalizedSeasonNumber ? normalizedSeasonNumber - 1 : -1;
    const seasonMatch = seasonIndex >= 0 ? parsePositiveInt(data[seasonIndex]?.myanimelist) : null;
    if (seasonMatch) return seasonMatch;

    for (const item of data) {
      const malId = parsePositiveInt(item?.myanimelist);
      if (malId) return malId;
    }

    return null;
  }

  async function fetchArmMALId(metaId, seasonNumber) {
    let url;
    if (metaId.startsWith("kitsu:")) {
      url = `https://arm.haglund.dev/api/v2/ids?source=kitsu&id=${encodeURIComponent(metaId.split(":")[1])}&include=myanimelist`;
    } else if (metaId.startsWith("tt")) {
      url = `https://arm.haglund.dev/api/v2/imdb?id=${encodeURIComponent(metaId.split(":")[0])}&include=myanimelist,thetvdb-season`;
    } else {
      return null;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json();
      const malId = pickArmMALId(data, seasonNumber);
      if (malId) {
        return malId;
      }
    } catch {}

    return null;
  }

  async function fetchMALId(metaId, seasonNumber = 0) {
    // Direct Kitsu API query (CORS-enabled)
    if (metaId.startsWith("kitsu:")) {
      const kitsuId = metaId.split(":")[1];
      try {
        const response = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`);
        if (response.ok) {
          const json = await response.json();
          const malMapping = json.data?.find(item => item.attributes?.externalSite === "myanimelist/anime");
          if (malMapping?.attributes?.externalId) {
            const malId = parseInt(malMapping.attributes.externalId, 10);
            return malId;
          }
        }
      } catch {}
    }

    // Anime Relations Mapping
    const armMalId = await fetchArmMALId(metaId, seasonNumber);
    if (armMalId) return armMalId;

    if (!metaId.startsWith("kitsu:") && !metaId.startsWith("tt")) {
      return null;
    }

    return null;
  }

  const jikanRelationsCache = new Map();
  const resolvedMalIdCache = new Map();

  async function fetchJikanRelations(malId) {
    if (jikanRelationsCache.has(malId)) {
      return jikanRelationsCache.get(malId);
    }
    const url = `https://api.jikan.moe/v4/anime/${malId}/relations`;
    try {
      //  delay to respect Jikan's rate limits
      await new Promise(resolve => setTimeout(resolve, 350));
      const response = await fetch(url);
      if (response.ok) {
        const json = await response.json();
        const data = json.data || [];
        jikanRelationsCache.set(malId, data);
        return data;
      }
    } catch {}
    return [];
  }

  async function getSeasonMalId(initialMalId, targetSeason) {
    const cacheKey = `${initialMalId}:${targetSeason}`;
    if (resolvedMalIdCache.has(cacheKey)) {
      return resolvedMalIdCache.get(cacheKey);
    }

    let currentId = initialMalId;
    let visited = new Set();
    
    // 1. Traverse prequels to find Season 1
    for (let i = 0; i < 10; i++) {
      visited.add(currentId);
      const relations = await fetchJikanRelations(currentId);
      const prequel = relations.find(r => r.relation === "Prequel")?.entry?.find(e => e.type === "anime");
      if (prequel && prequel.mal_id && !visited.has(prequel.mal_id)) {
        currentId = prequel.mal_id;
      } else {
        break;
      }
    }
    
    const season1Id = currentId;
    const seasons = [season1Id];
    currentId = season1Id;
    visited.clear();
    
    // 2. Traverse sequels to build the ordered season list
    for (let i = 0; i < 10; i++) {
      visited.add(currentId);
      const relations = await fetchJikanRelations(currentId);
      const sequel = relations.find(r => r.relation === "Sequel")?.entry?.find(e => e.type === "anime");
      if (sequel && sequel.mal_id && !visited.has(sequel.mal_id)) {
        seasons.push(sequel.mal_id);
        currentId = sequel.mal_id;
      } else {
        break;
      }
    }
    
    const resolvedId = seasons[targetSeason - 1] || initialMalId;
    resolvedMalIdCache.set(cacheKey, resolvedId);
    return resolvedId;
  }

  async function fetchSkipTimes(malId, episode, duration) {
    const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types[]=op&types[]=ed&types[]=recap&episodeLength=${duration}`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.found) return data.results;
      }
    } catch {}
    return [];
  }

  // --- UI ---

  function injectTimelineMarks(segments, duration) {
    pollElement(".slider-hBDOf", (slider) => {
      slider.querySelectorAll(".aniskip-timeline-mark").forEach(mark => mark.remove());

      for (const segment of segments) {
        const { startTime, endTime } = segment.interval;
        const left = (startTime / duration) * 100;
        const width = ((endTime - startTime) / duration) * 100;

        const mark = document.createElement("div");
        mark.classList.add("aniskip-timeline-mark");
        mark.style.left = `${left}%`;
        mark.style.width = `${width}%`;

        const thumb = slider.querySelector('[class*="thumb"]') || slider.lastElementChild;
        if (thumb && thumb !== mark) {
          thumb.parentNode.insertBefore(mark, thumb);
        } else {
          slider.appendChild(mark);
        }
      }
    });
  }

  function seekNatively(targetTime) {
    _eval(`
      window.chrome.webview.postMessage({
        id: Math.floor(Math.random() * 1000000),
        type: 6,
        args: ["mpv-command", ["seek", "${targetTime}", "absolute"]]
      });
    `);
  }

  function showSkipPopup(segment) {
    removePopup();

    const label = SKIP_TYPE_LABELS[segment.skipType] || segment.skipType;

    popupElement = document.createElement("button");
    popupElement.className = "aniskip-v2-popup";
    popupElement.textContent = `Skip ${label}`;

    const playerContainer =
      document.querySelector(".player-container-wIELK") ||
      document.querySelector(".video-container") ||
      document.querySelector(".stremio-player") ||
      document.querySelector(".slider-container-nJz5F")?.parentElement ||
      document.body;

    playerContainer.appendChild(popupElement);

    popupElement.addEventListener("click", () => {
      seekNatively(segment.interval.endTime);
      removePopup();
    });
  }

  // --- Playback Monitoring ---

  function stopPlayerPolling() {
    if (playerPollInterval) {
      clearInterval(playerPollInterval);
      playerPollInterval = null;
    }
  }

  function stopPlaybackMonitoring() {
    if (playbackMonitorInterval) {
      clearInterval(playbackMonitorInterval);
      playbackMonitorInterval = null;
    }
  }

  function monitorVideo(segments, duration) {
    stopPlaybackMonitoring();

    const triggered = new Set();

    playbackMonitorInterval = setInterval(() => {
      if (!isOnPlayerPage()) {
        stopPlaybackMonitoring();
        return;
      }

      const curr = currentTime;

      for (const segment of segments) {
        const { startTime, endTime } = segment.interval;
        const segId = segment.skipId;

        if (curr >= startTime && curr < endTime) {
          if (!triggered.has(segId)) {
            triggered.add(segId);
            if (autoSkipEnabled) {
              seekNatively(endTime);
            } else {
              showSkipPopup(segment);
            }
          }
        } else if (triggered.has(segId)) {
          triggered.delete(segId);
          removePopup();
        }
      }
    }, 800);
  }

  // --- Episode Loading ---

  async function loadAniSkipForEpisode(metaInfo, seasonNumber, episodeNumber) {
    // Fetch MAL ID and poll for duration in parallel
    const malIdPromise = (async () => {
      let malId = await fetchMALId(metaInfo.id, seasonNumber);
      if (malId && seasonNumber > 0 && metaInfo.type === "series") {
        malId = await getSeasonMalId(malId, seasonNumber);
      }
      return malId;
    })();

    const durationPromise = (async () => {
      for (let i = 0; i < 60; i++) {
        if (!isOnPlayerPage()) return 0;
        if (currentDuration > 0 && !isNaN(currentDuration)) return currentDuration;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      return 0;
    })();

    const [malId, duration] = await Promise.all([malIdPromise, durationPromise]);

    if (!malId) {
      return;
    }

    if (!duration || isNaN(duration)) {
      return;
    }

    const segments = await fetchSkipTimes(malId, episodeNumber, duration);
    if (segments.length > 0) {
      injectTimelineMarks(segments, duration);
      monitorVideo(segments, duration);
    }
  }

  // --- Player State Polling ---

  function startPlayerPolling() {
    stopPlayerPolling();
    stopPlaybackMonitoring();

    currentDuration = 0;
    currentTime = 0;

    initMpvIpcListener();

    playerPollInterval = setInterval(async () => {
      if (!isOnPlayerPage()) {
        stopPlayerPolling();
        return;
      }

      const state = await _eval("window.services?.core?.transport?.getState('player')");
      if (!state?.seriesInfo || !state?.metaItem?.content) return;

      const metaInfo = state.metaItem.content;
      const seasonNumber = state.seriesInfo.season || 1;
      const episodeNumber = state.seriesInfo.episode;
      const episodeKey = `${metaInfo.id}:${seasonNumber}:${episodeNumber}`;

      if (episodeKey === currentEpisodeKey) {
        stopPlayerPolling();
        return;
      }

      stopPlayerPolling();
      currentEpisodeKey = episodeKey;

      await loadAniSkipForEpisode(metaInfo, seasonNumber, episodeNumber);
    }, 1000);
  }

  // --- Routing ---

  function handleHashChange() {
    if (isOnPlayerPage()) {
      startPlayerPolling();
    } else {
      stopPlayerPolling();
      stopPlaybackMonitoring();
      currentEpisodeKey = null;
      currentDuration = 0;
      currentTime = 0;

      if (unlistenFn) {
        unlistenFn();
        unlistenFn = null;
      }
      ipcInitialized = false;

      removePopup();
    }
  }

  window.addEventListener("hashchange", handleHashChange);
  window.addEventListener("load", handleHashChange);

  // Initialize settings
  registerPluginSettings();
  loadSettings();
  listenForSettingsChanges();

  if (isOnPlayerPage()) {
    startPlayerPolling();
  }
})();
