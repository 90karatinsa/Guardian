const KNOWN_CHANNEL_PREFIXES = new Set(['video', 'audio']);
const LAYOUT_BREAKPOINTS = [
  { name: 'compact', query: '(max-width: 640px)' },
  { name: 'tablet', query: '(max-width: 1024px)' }
];

function resolveDefaultChannelType(options) {
  const configured = options?.defaultType;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim().toLowerCase();
  }
  return 'video';
}

function normalizeKnownChannelPrefix(prefix) {
  const lower = prefix.toLowerCase();
  if (KNOWN_CHANNEL_PREFIXES.has(lower)) {
    return lower;
  }
  return prefix;
}

function normalizeChannelId(value, options) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    return '';
  }

  const match = /^([a-z0-9_-]+):(.*)$/i.exec(trimmed);
  if (match) {
    const [, rawPrefix, remainder] = match;
    const prefix = normalizeKnownChannelPrefix(rawPrefix);
    return `${prefix}:${remainder}`;
  }

  const defaultType = resolveDefaultChannelType(options);
  return `${defaultType}:${trimmed}`;
}

const dashboardContainer = document.querySelector('main.dashboard-grid');
const list = document.getElementById('events');
const filtersForm = document.getElementById('filters');
const resetButton = document.getElementById('reset-filters');
const previewPanel = document.getElementById('preview');
const previewEmpty = document.getElementById('preview-empty');
const previewFigure = document.getElementById('preview-figure');
const previewImage = document.getElementById('preview-image');
const previewCaption = document.getElementById('preview-caption');
const previewCaptionText = document.getElementById('preview-caption-text');
const previewFaceImage = document.getElementById('preview-face-image');
const previewFaceCaption = document.getElementById('preview-face-caption');
const streamState = document.getElementById('stream-state');
const streamHeartbeats = document.getElementById('stream-heartbeats');
const streamEvents = document.getElementById('stream-events');
const streamSnapshots = document.getElementById('stream-snapshots');
const streamUpdated = document.getElementById('stream-updated');
const streamHealth = document.getElementById('stream-health');
const poseConfidence = document.getElementById('pose-confidence');
const poseMovement = document.getElementById('pose-movement');
const poseThreatIndicator = document.getElementById('pose-threat');
const channelFilter = document.getElementById('channel-filter');
const channelFilterOptions = document.getElementById('channel-filter-options');
const channelFilterEmpty = document.getElementById('channel-filter-empty');
const pipelineMetricsContainer = document.getElementById('pipeline-metrics');
const pipelineMetricsEmpty = document.getElementById('pipeline-metrics-empty');
const threatSummaryContainer = document.getElementById('threat-summary');
const threatSummaryEmpty = document.getElementById('threat-summary-empty');
const channelStatusContainer = document.getElementById('channel-status');
const channelStatusEmpty = document.getElementById('channel-status-empty');
const warningList = document.getElementById('warning-list');
const warningEmpty = document.getElementById('warning-empty');

if (previewPanel) {
  previewPanel.setAttribute('aria-busy', 'false');
}

if (previewImage) {
  previewImage.addEventListener('load', () => {
    previewImage.dataset.state = 'loaded';
  });
  previewImage.addEventListener('error', () => {
    previewImage.dataset.state = 'error';
  });
}

if (previewFaceImage) {
  previewFaceImage.addEventListener('load', () => {
    previewFaceImage.dataset.state = 'loaded';
  });
  previewFaceImage.addEventListener('error', () => {
    previewFaceImage.dataset.state = 'error';
  });
}

const MAX_EVENTS = 50;

const state = {
  events: [],
  filters: {
    source: '',
    camera: '',
    severity: '',
    from: '',
    to: '',
    search: '',
    snapshot: '',
    channelQuery: '',
    channels: new Set()
  },
  activeId: null,
  eventSource: null,
  lastEventId: null,
  reconnectDelayMs: 5000,
  retryHint: null,
  stream: {
    heartbeats: 0,
    events: 0,
    snapshots: 0,
    lastUpdate: null,
    status: 'connecting',
    health: 'Unknown'
  },
  channelStats: new Map(),
  metrics: {
    pending: false,
    lastFetched: null,
    data: null
  },
  summary: null,
  digest: null,
  pose: {
    lastForecast: null,
    lastThreat: null,
    lastUpdated: null
  },
  warnings: [],
  offlineBanner: null,
  layout: {
    active: 'wide',
    breakpoints: LAYOUT_BREAKPOINTS.map(({ name, query }) => ({ name, query })),
    container: dashboardContainer ?? null,
    watchers: [],
    applyLayout: null
  }
};

function isDomAvailable() {
  return (
    typeof document !== 'undefined' &&
    document !== null &&
    typeof document.createElement === 'function' &&
    typeof document.createDocumentFragment === 'function'
  );
}

function clampReconnectDelay(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  if (!Number.isFinite(normalized)) {
    return null;
  }
  return Math.max(1000, Math.min(normalized, 60000));
}

function getOfflineBannerElement() {
  const banner = state.offlineBanner;
  if (!banner) {
    return null;
  }
  const ownerDocument = banner.ownerDocument;
  if (ownerDocument?.body?.contains(banner)) {
    return banner;
  }
  if (isDomAvailable() && document.body?.contains(banner)) {
    return banner;
  }
  return null;
}

function ensureOfflineBannerElement() {
  if (!isDomAvailable()) {
    return null;
  }
  const existing = getOfflineBannerElement();
  if (existing) {
    return existing;
  }
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'offline-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.setAttribute('aria-atomic', 'true');
  banner.hidden = true;
  const header = document.querySelector('.dashboard-header');
  if (header && header.parentElement) {
    header.parentElement.insertBefore(banner, header.nextSibling);
  } else if (document.body) {
    document.body.prepend(banner);
  }
  state.offlineBanner = banner;
  return banner;
}

function hideOfflineBanner() {
  const banner = getOfflineBannerElement();
  if (!banner) {
    return;
  }
  banner.hidden = true;
  banner.textContent = '';
}

function formatReconnectDelay(delayMs) {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
    return 'soon';
  }
  const seconds = Math.max(1, Math.round(delayMs / 1000));
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function showOfflineBanner(delayMs) {
  const banner = ensureOfflineBannerElement();
  const delayText = formatReconnectDelay(delayMs);
  banner.textContent = `Connection lost. Reconnecting in ${delayText}…`;
  banner.hidden = false;
}

function normalizeRetryHint(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const baseCandidate =
    clampReconnectDelay(payload.baseMs) ??
    clampReconnectDelay(payload.retryMs) ??
    clampReconnectDelay(payload.defaultMs) ??
    clampReconnectDelay(state.reconnectDelayMs);
  const minCandidate =
    clampReconnectDelay(payload.minMs) ??
    clampReconnectDelay(payload.minimumMs) ??
    clampReconnectDelay(payload.min) ??
    baseCandidate;
  const maxCandidate =
    clampReconnectDelay(payload.maxMs) ??
    clampReconnectDelay(payload.maximumMs) ??
    clampReconnectDelay(payload.max) ??
    baseCandidate;
  const recommendedCandidate =
    clampReconnectDelay(payload.recommendedMs) ??
    clampReconnectDelay(payload.recommended) ??
    clampReconnectDelay(payload.suggestedMs) ??
    clampReconnectDelay(payload.hintMs) ??
    baseCandidate;

  if (!baseCandidate && !minCandidate && !maxCandidate && !recommendedCandidate) {
    return null;
  }

  const baseMs = baseCandidate ?? 5000;
  const minMs = Math.min(minCandidate ?? baseMs, maxCandidate ?? baseMs);
  const maxMs = Math.max(maxCandidate ?? baseMs, minCandidate ?? baseMs);
  const recommendedMsRaw = recommendedCandidate ?? baseMs;
  const recommendedMs = Math.min(Math.max(recommendedMsRaw, minMs), maxMs);

  return { baseMs, minMs, maxMs, recommendedMs };
}

function pickReconnectDelay() {
  const hint = state.retryHint;
  if (hint && typeof hint === 'object') {
    const minMs = clampReconnectDelay(hint.minMs) ?? clampReconnectDelay(state.reconnectDelayMs) ?? 5000;
    const maxMs = clampReconnectDelay(hint.maxMs) ?? minMs;
    const lower = Math.min(minMs, maxMs);
    const upper = Math.max(minMs, maxMs);
    if (upper <= lower) {
      return lower;
    }
    const span = upper - lower;
    const sample = lower + Math.floor(Math.random() * (span + 1));
    return clampReconnectDelay(sample) ?? lower;
  }

  return clampReconnectDelay(state.reconnectDelayMs) ?? 5000;
}

function updateRetryHint(payload) {
  const hint = normalizeRetryHint(payload);
  if (!hint) {
    return;
  }
  state.retryHint = hint;
  state.reconnectDelayMs = hint.recommendedMs;
}

function parseEventId(candidate) {
  if (candidate === null || typeof candidate === 'undefined') {
    return null;
  }
  if (typeof candidate === 'number') {
    return Number.isFinite(candidate) ? Math.floor(candidate) : null;
  }
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function recordLastEventId(candidate) {
  const id = parseEventId(candidate);
  if (id === null || id < 0) {
    return;
  }
  if (typeof state.lastEventId === 'number' && Number.isFinite(state.lastEventId)) {
    state.lastEventId = Math.max(state.lastEventId, id);
  } else {
    state.lastEventId = id;
  }
}

function syncLastEventIdFromEvents(events) {
  if (!Array.isArray(events)) {
    return;
  }
  for (const entry of events) {
    if (entry && typeof entry === 'object') {
      recordLastEventId(entry.id);
    }
  }
}

function getSelectedChannels() {
  if (!(state.filters.channels instanceof Set)) {
    state.filters.channels = new Set();
  }
  return state.filters.channels;
}

function initializeResponsiveLayout() {
  if (!dashboardContainer) {
    return;
  }

  state.layout.container = dashboardContainer;
  const supportsMatchMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const watchers = supportsMatchMedia
    ? LAYOUT_BREAKPOINTS.map(({ name, query }) => ({ name, query, matcher: window.matchMedia(query) }))
    : [];

  const applyLayout = () => {
    let next = 'wide';
    for (const watcher of watchers) {
      if (watcher.matcher.matches) {
        next = watcher.name;
        break;
      }
    }

    if (dashboardContainer.dataset.layout !== next) {
      dashboardContainer.dataset.layout = next;
    }
    if (previewPanel) {
      previewPanel.dataset.layout = next;
    }
    state.layout.active = next;
  };

  watchers.forEach(({ matcher }) => {
    const handler = () => applyLayout();
    if (typeof matcher.addEventListener === 'function') {
      matcher.addEventListener('change', handler);
    } else if (typeof matcher.addListener === 'function') {
      matcher.addListener(handler);
    }
  });

  state.layout.watchers = watchers.map(({ name, query }) => ({ name, query }));
  state.layout.applyLayout = applyLayout;
  applyLayout();
}

function getEventKey(event) {
  if (typeof event.id === 'number') {
    return `id:${event.id}`;
  }
  const detector = event.detector ?? 'unknown';
  const source = event.source ?? 'unknown';
  const ts = typeof event.ts === 'number' ? event.ts : Date.now();
  const message = event.message ?? '';
  return `ts:${ts}:${detector}:${source}:${message}`;
}

function withKey(event) {
  const key = getEventKey(event);
  return { ...event, __key: key };
}

function formatRelativeTime(input) {
  if (!input) {
    return 'never';
  }
  const timestamp = typeof input === 'number' ? input : Date.parse(String(input));
  if (!Number.isFinite(timestamp)) {
    return 'unknown';
  }
  const delta = Date.now() - timestamp;
  if (delta < 30_000) {
    return 'just now';
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(timestamp).toLocaleString();
}

function getEventChannel(event) {
  const meta = event.meta ?? {};
  if (typeof meta.channel === 'string' && meta.channel) {
    return normalizeChannelId(meta.channel);
  }
  if (typeof meta.camera === 'string' && meta.camera) {
    return normalizeChannelId(meta.camera);
  }
  if (typeof event.source === 'string' && event.source) {
    return normalizeChannelId(event.source);
  }
  return '';
}

function matchesFilters(event) {
  const meta = event.meta ?? {};
  const resolvedChannel = getEventChannel(event);
  const metaChannel = typeof meta.channel === 'string' ? normalizeChannelId(meta.channel) : '';
  const cameraMeta = typeof meta.camera === 'string' ? normalizeChannelId(meta.camera) : '';
  const channelQuery = state.filters.channelQuery
    .split(',')
    .map(token => normalizeChannelId(token))
    .filter(token => token.length > 0);
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';
  const ts = typeof event.ts === 'number' ? event.ts : Date.now();
  const selectedChannels = getSelectedChannels();

  if (state.filters.source && event.source !== state.filters.source) {
    return false;
  }
  if (state.filters.camera) {
    const normalizedCameraFilter = normalizeChannelId(state.filters.camera);
    const cameraMatches =
      event.source === state.filters.camera ||
      cameraMeta === state.filters.camera ||
      metaChannel === state.filters.camera ||
      resolvedChannel === state.filters.camera ||
      normalizeChannelId(event.source) === normalizedCameraFilter ||
      cameraMeta === normalizedCameraFilter ||
      metaChannel === normalizedCameraFilter ||
      resolvedChannel === normalizedCameraFilter;
    if (!cameraMatches) {
      return false;
    }
  }
  if (selectedChannels instanceof Set && selectedChannels.size > 0) {
    if (!resolvedChannel || !selectedChannels.has(resolvedChannel)) {
      return false;
    }
  }
  if (channelQuery.length > 0 && !channelQuery.includes(resolvedChannel)) {
    return false;
  }
  if (state.filters.severity && event.severity !== state.filters.severity) {
    return false;
  }
  if (state.filters.snapshot === 'with' && !snapshotPath) {
    return false;
  }
  if (state.filters.snapshot === 'without' && snapshotPath) {
    return false;
  }

  if (state.filters.search) {
    const search = state.filters.search.toLowerCase();
    const haystack = [
      event.message,
      event.detector,
      event.source,
      meta.channel,
      metaChannel,
      resolvedChannel,
      meta.camera,
      cameraMeta,
      snapshotPath
    ]
      .filter(value => typeof value === 'string')
      .map(value => value.toLowerCase());

    if (!haystack.some(value => value.includes(search))) {
      return false;
    }
  }

  const fromTs = parseDateFilter(state.filters.from);
  if (fromTs && ts < fromTs) {
    return false;
  }

  const toTs = parseDateFilter(state.filters.to);
  if (toTs && ts > toTs) {
    return false;
  }

  return true;
}

function sortEvents(events) {
  return events.sort((a, b) => {
    if (b.ts === a.ts) {
      return (b.id ?? 0) - (a.id ?? 0);
    }
    return b.ts - a.ts;
  });
}

function renderEvents() {
  if (!list) {
    return;
  }
  if (!isDomAvailable()) {
    return;
  }
  const filtered = state.events.filter(matchesFilters);
  const fragment = document.createDocumentFragment();

  filtered.slice(0, MAX_EVENTS).forEach(event => {
    fragment.appendChild(renderEventCard(event));
  });

  list.replaceChildren(fragment);

  if (state.activeId) {
    const activeElement = list.querySelector(`[data-event-id="${state.activeId}"]`);
    if (!activeElement) {
      clearPreview();
    }
  }

  if (filtered.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No events match the current filters yet.';
    list.appendChild(empty);
  }
}

function renderEventCard(event) {
  if (!isDomAvailable()) {
    const doc = typeof document !== 'undefined' ? document : list?.ownerDocument ?? null;
    if (doc && typeof doc.createElement === 'function') {
      return doc.createElement('article');
    }
    return { appendChild() {}, classList: { add() {} }, dataset: {} };
  }
  const container = document.createElement('article');
  container.className = 'event';
  container.dataset.eventId = event.__key;
  if (event.__key === state.activeId) {
    container.classList.add('active');
  }

  const header = document.createElement('header');
  const title = document.createElement('strong');
  title.textContent = `${event.detector} · ${event.source}`;
  header.appendChild(title);

  const severity = document.createElement('span');
  severity.className = `severity ${event.severity}`;
  severity.textContent = event.severity;
  header.appendChild(severity);

  const message = document.createElement('p');
  message.textContent = event.message;

  const timestamp = document.createElement('p');
  timestamp.className = 'meta';
  timestamp.textContent = new Date(event.ts).toLocaleString();

  container.appendChild(header);
  container.appendChild(message);
  container.appendChild(timestamp);

  container.addEventListener('click', () => {
    setActiveEvent(event.__key);
  });

  return container;
}

function setActiveEvent(eventKey) {
  if (state.activeId === eventKey) {
    return;
  }

  state.activeId = eventKey;
  for (const element of list.querySelectorAll('.event')) {
    element.classList.toggle('active', element.dataset.eventId === eventKey);
  }

  const event = state.events.find(item => item.__key === eventKey);
  if (!event) {
    clearPreview();
    return;
  }

  showPreview(event);
}

function showPreview(event) {
  const timestamp = new Date(event.ts).toLocaleString();
  const description = `${event.detector} · ${event.source}`;
  const captionValue = `${description} — ${timestamp}`;
  if (previewPanel) {
    previewPanel.setAttribute('aria-busy', 'true');
  }
  if (previewCaptionText) {
    previewCaptionText.textContent = captionValue;
  } else if (previewCaption) {
    previewCaption.textContent = captionValue;
  }

  const meta = event.meta ?? {};
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : null;
  const snapshotUrl = typeof meta.snapshotUrl === 'string' ? meta.snapshotUrl : null;
  const faceSnapshotUrl = typeof meta.faceSnapshotUrl === 'string' ? meta.faceSnapshotUrl : null;
  const faceSnapshotMeta =
    typeof (meta.faceSnapshot ?? meta.face?.snapshot) === 'string'
      ? (meta.faceSnapshot ?? meta.face?.snapshot)
      : null;

  let resolvedUrl = snapshotUrl;
  if (!resolvedUrl && typeof event.id === 'number' && snapshotPath) {
    resolvedUrl = `/api/events/${event.id}/snapshot`;
  } else if (!resolvedUrl && snapshotPath) {
    resolvedUrl = snapshotPath;
  }

  let resolvedFaceUrl = faceSnapshotUrl;
  if (!resolvedFaceUrl && typeof event.id === 'number' && typeof faceSnapshotMeta === 'string') {
    resolvedFaceUrl = `/api/events/${event.id}/face-snapshot`;
  } else if (!resolvedFaceUrl && typeof faceSnapshotMeta === 'string') {
    resolvedFaceUrl = faceSnapshotMeta;
  }

  const hasMain = Boolean(resolvedUrl);
  const hasFace = Boolean(resolvedFaceUrl);

  if (previewImage) {
    if (hasMain && resolvedUrl) {
      const cacheKey = encodeURIComponent(buildSnapshotCacheKey(event));
      const separator = resolvedUrl.includes('?') ? '&' : '?';
      previewImage.hidden = false;
      previewImage.src = `${resolvedUrl}${separator}cacheBust=${cacheKey}`;
      previewImage.dataset.channel = getEventChannel(event) || '';
      previewImage.dataset.state = 'loading';
      previewImage.alt = `Snapshot for ${description}`;
    } else {
      previewImage.hidden = true;
      previewImage.dataset.channel = '';
      previewImage.dataset.state = 'idle';
      previewImage.removeAttribute('src');
    }
  }

  if (previewFaceImage) {
    if (hasFace && resolvedFaceUrl) {
      const cacheKey = encodeURIComponent(`${buildSnapshotCacheKey(event)}-face`);
      const separator = resolvedFaceUrl.includes('?') ? '&' : '?';
      previewFaceImage.hidden = false;
      previewFaceImage.src = `${resolvedFaceUrl}${separator}cacheBust=${cacheKey}`;
      previewFaceImage.dataset.channel = getEventChannel(event) || '';
      previewFaceImage.dataset.state = 'loading';
      previewFaceImage.alt = `Face snapshot for ${description}`;
    } else {
      previewFaceImage.hidden = true;
      previewFaceImage.dataset.state = 'idle';
      previewFaceImage.dataset.channel = '';
      previewFaceImage.removeAttribute('src');
    }
  }

  if (previewFaceCaption) {
    previewFaceCaption.textContent = hasFace ? 'Face snapshot available' : '';
  }

  if (hasMain || hasFace) {
    previewFigure.hidden = false;
    previewFigure.setAttribute('aria-hidden', 'false');
    previewEmpty.hidden = true;
    previewEmpty.setAttribute('aria-hidden', 'true');
  } else {
    previewFigure.hidden = true;
    previewFigure.setAttribute('aria-hidden', 'true');
    previewEmpty.hidden = false;
    previewEmpty.setAttribute('aria-hidden', 'false');
    previewEmpty.textContent = 'No snapshot is available for the selected event.';
  }

  if (previewPanel) {
    previewPanel.setAttribute('aria-busy', 'false');
  }
}

function clearPreview() {
  state.activeId = null;
  if (previewPanel) {
    previewPanel.setAttribute('aria-busy', 'false');
  }
  previewFigure.hidden = true;
  previewFigure.setAttribute('aria-hidden', 'true');
  previewEmpty.hidden = false;
  previewEmpty.setAttribute('aria-hidden', 'false');
  previewEmpty.textContent = 'Select an event to view the latest snapshot.';
  if (previewCaptionText) {
    previewCaptionText.textContent = '';
  } else if (previewCaption) {
    previewCaption.textContent = '';
  }
  if (previewImage) {
    previewImage.dataset.channel = '';
    previewImage.dataset.state = 'idle';
    previewImage.removeAttribute('src');
    previewImage.hidden = true;
  }
  if (previewFaceImage) {
    previewFaceImage.hidden = true;
    previewFaceImage.dataset.state = 'idle';
    previewFaceImage.dataset.channel = '';
    previewFaceImage.removeAttribute('src');
  }
  if (previewFaceCaption) {
    previewFaceCaption.textContent = '';
  }
}

function updateStreamWidget() {
  if (streamState) {
    const status = state.stream.status;
    const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : '—';
    streamState.textContent = label;
  }
  if (streamHeartbeats) {
    streamHeartbeats.textContent = String(state.stream.heartbeats);
  }
  if (streamEvents) {
    streamEvents.textContent = String(state.stream.events);
  }
  if (streamSnapshots) {
    streamSnapshots.textContent = String(state.stream.snapshots);
  }
  if (streamUpdated) {
    streamUpdated.textContent = state.stream.lastUpdate
      ? new Date(state.stream.lastUpdate).toLocaleTimeString()
      : '—';
  }
  if (streamHealth) {
    streamHealth.textContent = state.stream.health ?? 'Unknown';
  }
}

function updatePoseWidget() {
  if (poseConfidence) {
    const text = formatPercent(state.pose.lastForecast?.confidence ?? null);
    poseConfidence.textContent = text ?? '—';
  }

  if (poseMovement) {
    const count = state.pose.lastForecast?.movingJointCount;
    const ratioText = formatPercent(state.pose.lastForecast?.movingJointRatio ?? null);
    if (typeof count === 'number' && Number.isFinite(count)) {
      poseMovement.textContent = ratioText ? `${count} joints (${ratioText})` : `${count} joints`;
    } else if (ratioText) {
      poseMovement.textContent = ratioText;
    } else {
      poseMovement.textContent = '—';
    }
  }

  if (poseThreatIndicator) {
    const threat = state.pose.lastThreat;
    const hasPoseData = Boolean(state.pose.lastForecast || threat || state.pose.lastUpdated);
    if (threat) {
      const label = threat.label && typeof threat.label === 'string' ? threat.label : 'Threat';
      const scoreText = formatPercent(threat.threatScore ?? null);
      poseThreatIndicator.textContent = scoreText ? `${label} (${scoreText})` : label;
    } else if (hasPoseData) {
      poseThreatIndicator.textContent = 'No threat';
    } else {
      poseThreatIndicator.textContent = '—';
    }
  }
}

function setConnectionState(status) {
  state.stream.status = status;
  if (status === 'connected' || status === 'connecting') {
    hideOfflineBanner();
  }
  updateStreamWidget();
}

function resetStreamStats() {
  state.stream.heartbeats = 0;
  state.stream.events = 0;
  state.stream.snapshots = 0;
  state.stream.lastUpdate = null;
  setHealthStatus('Unknown');
  updateStreamWidget();
}

function recordHeartbeat(timestamp) {
  state.stream.heartbeats += 1;
  state.stream.lastUpdate = typeof timestamp === 'number' ? timestamp : Date.now();
  updateStreamWidget();
}

function recordStreamEvent(timestamp) {
  state.stream.events += 1;
  state.stream.lastUpdate = typeof timestamp === 'number' ? timestamp : Date.now();
  updateStreamWidget();
}

function recordSnapshotEvent() {
  state.stream.snapshots += 1;
  updateStreamWidget();
}

function appendWarning(entry) {
  if (!entry) {
    return;
  }
  if (!Array.isArray(state.warnings)) {
    state.warnings = [];
  }
  state.warnings.unshift(entry);
  if (state.warnings.length > 20) {
    state.warnings.length = 20;
  }
  renderWarnings();
}

function normalizeWarning(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const now = Date.now();
  if (payload.type === 'retention' && payload.warning) {
    const warning = payload.warning as { camera?: string | null; reason?: string; path?: string };
    const camera = warning.camera ? normalizeChannelId(warning.camera) : null;
    const reason = typeof warning.reason === 'string' ? warning.reason : 'Retention warning';
    const detail = typeof warning.path === 'string' ? warning.path : null;
    return {
      id: `retention:${now}:${Math.random().toString(36).slice(2)}`,
      type: 'retention',
      title: camera ? `Retention warning (${camera})` : 'Retention warning',
      message: reason,
      detail,
      channel: camera,
      at: now
    };
  }
  if (payload.type === 'transport-fallback' && payload.fallback) {
    const fallback = payload.fallback as {
      channel?: string | null;
      from?: string | null;
      to?: string | null;
      reason?: string;
      at?: string | number | null;
      resetsBackoff?: boolean;
      resetsCircuitBreaker?: boolean;
    };
    const channel = fallback.channel ? normalizeChannelId(fallback.channel) : null;
    const from = fallback.from || 'unknown';
    const to = fallback.to || 'unknown';
    const reason = fallback.reason || 'fallback';
    const atValue =
      typeof fallback.at === 'number'
        ? fallback.at
        : typeof fallback.at === 'string'
        ? Date.parse(fallback.at)
        : now;
    const detailParts: string[] = [];
    if (fallback.resetsBackoff) {
      detailParts.push('backoff reset');
    }
    if (fallback.resetsCircuitBreaker) {
      detailParts.push('circuit breaker reset');
    }
    return {
      id: `transport:${now}:${Math.random().toString(36).slice(2)}`,
      type: 'transport-fallback',
      title: channel ? `Transport fallback (${channel})` : 'Transport fallback',
      message: `${from} → ${to} (${reason})`,
      detail: detailParts.length > 0 ? detailParts.join(', ') : null,
      channel,
      at: Number.isFinite(atValue) ? atValue : now
    };
  }
  if (payload.type === 'suppression' && payload.suppression) {
    const suppression = payload.suppression as {
      ruleId?: string | null;
      channel?: string | null;
      count?: number;
      timelineTtlMs?: number | null;
      timelineExpired?: boolean | null;
      at?: string | number | null;
    };
    const channel = suppression.channel ? normalizeChannelId(suppression.channel) : null;
    const count =
      typeof suppression.count === 'number' && Number.isFinite(suppression.count)
        ? suppression.count
        : null;
    const ttlMs =
      typeof suppression.timelineTtlMs === 'number' && Number.isFinite(suppression.timelineTtlMs)
        ? suppression.timelineTtlMs
        : null;
    const expired =
      typeof suppression.timelineExpired === 'boolean' ? suppression.timelineExpired : null;
    const atValue =
      typeof suppression.at === 'number'
        ? suppression.at
        : typeof suppression.at === 'string'
        ? Date.parse(suppression.at)
        : now;
    const detailParts: string[] = [];
    if (ttlMs !== null) {
      detailParts.push(`ttl ${ttlMs}ms`);
    }
    if (suppression.ruleId) {
      detailParts.push(`rule ${suppression.ruleId}`);
    }
    if (expired !== null) {
      detailParts.push(expired ? 'timeline expired' : 'timeline active');
    }
    const title = channel ? `Suppression TTL pruned (${channel})` : 'Suppression TTL pruned';
    let message = 'Suppression timeline pruned by TTL';
    if (count !== null) {
      message = count === 1 ? '1 suppression entry pruned' : `${count} suppression entries pruned`;
    }
    return {
      id: `suppression:${now}:${Math.random().toString(36).slice(2)}`,
      type: 'suppression',
      title,
      message,
      detail: detailParts.length > 0 ? detailParts.join(', ') : null,
      channel,
      at: Number.isFinite(atValue) ? atValue : now
    };
  }
  return null;
}

function renderWarnings() {
  if (!warningList || !warningEmpty) {
    return;
  }
  if (!isDomAvailable()) {
    return;
  }

  warningList.replaceChildren();
  const warnings = Array.isArray(state.warnings) ? state.warnings : [];
  if (warnings.length === 0) {
    warningEmpty.hidden = false;
    warningList.hidden = true;
    return;
  }

  warningEmpty.hidden = true;
  warningList.hidden = false;
  const fragment = document.createDocumentFragment();
  warnings.forEach(entry => {
    if (!entry) {
      return;
    }
    const item = document.createElement('li');
    item.className = 'warning-item';
    const title = document.createElement('strong');
    title.textContent = entry.title ?? 'Warning';
    item.appendChild(title);
    if (entry.message) {
      const message = document.createElement('span');
      message.textContent = entry.message;
      item.appendChild(message);
    }
    if (entry.detail) {
      const detail = document.createElement('span');
      detail.textContent = entry.detail;
      item.appendChild(detail);
    }
    const metaLine = document.createElement('span');
    metaLine.className = 'warning-meta';
    const relative = formatRelativeTime(entry.at ?? Date.now());
    const channelText = entry.channel ? ` • ${entry.channel}` : '';
    metaLine.textContent = `${relative}${channelText}`;
    item.appendChild(metaLine);
    fragment.appendChild(item);
  });
  warningList.appendChild(fragment);
}

async function loadInitial() {
  const params = buildQueryParams();
  params.set('limit', String(MAX_EVENTS));

  try {
    const response = await fetch(`/api/events?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to load events (${response.status})`);
    }
    const payload = await response.json();
    if (Array.isArray(payload.items)) {
      state.events = sortEvents(payload.items.map(withKey));
      syncLastEventIdFromEvents(payload.items);
      rebuildChannelsFromEvents();
      renderEvents();
      updateSummaries(payload.summary);
      if (payload.metrics) {
        setMetricsDigest(payload.metrics);
      }
    }
  } catch (error) {
    console.error('Failed to load events', error);
  }
}

function insertEvent(event) {
  const keyed = withKey(event);
  const existingIndex = state.events.findIndex(item => item.__key === keyed.__key);
  if (existingIndex >= 0) {
    state.events.splice(existingIndex, 1, keyed);
  } else {
    state.events.push(keyed);
  }
  sortEvents(state.events);
  if (state.events.length > MAX_EVENTS) {
    state.events.length = MAX_EVENTS;
  }
  recordLastEventId(keyed.id);
  const ts = typeof keyed.ts === 'number' ? keyed.ts : Date.now();
  registerChannel(getEventChannel(keyed), ts);
  renderEvents();
  updateSummaries();
  return keyed;
}

function registerChannel(channel, timestamp = Date.now()) {
  const normalized = normalizeChannelId(channel);
  if (!normalized) {
    return;
  }

  const stats = state.channelStats.get(normalized);
  if (stats) {
    if (timestamp > stats.lastSeen) {
      stats.lastSeen = timestamp;
      updateChannelFilterControls();
    }
    return;
  }

  state.channelStats.set(normalized, { firstSeen: timestamp, lastSeen: timestamp });
  updateChannelFilterControls();
}

function renderMetricsMessage(message) {
  if (!pipelineMetricsContainer) {
    return;
  }
  if (!isDomAvailable()) {
    pipelineMetricsContainer.textContent = message;
    return;
  }
  pipelineMetricsContainer.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'meta';
  note.textContent = message;
  pipelineMetricsContainer.appendChild(note);
}

function createMetricsRow(label, detail, options = {}) {
  if (!isDomAvailable()) {
    return null;
  }
  const item = document.createElement('div');
  item.className = 'metrics-channel';
  if (options.tooltip) {
    item.title = options.tooltip;
  }
  const name = document.createElement('span');
  name.textContent = label;
  if (options.badge) {
    const badge = document.createElement('span');
    const badgeClasses = ['status-badge'];
    if (options.badge.className) {
      badgeClasses.push(options.badge.className);
    }
    badge.className = badgeClasses.join(' ');
    badge.textContent = options.badge.label;
    if (options.badge.tooltip) {
      badge.title = options.badge.tooltip;
    }
    name.append(' ');
    name.append(badge);
  }
  const text = document.createElement('small');
  text.textContent = detail;
  item.append(name, text);
  return item;
}

function renderThreatSummary(summary) {
  if (!threatSummaryContainer) {
    return;
  }
  if (!isDomAvailable()) {
    return;
  }
  threatSummaryContainer.innerHTML = '';
  if (!summary) {
    if (threatSummaryEmpty) {
      threatSummaryEmpty.hidden = false;
    }
    return;
  }
  if (threatSummaryEmpty) {
    threatSummaryEmpty.hidden = true;
  }

  const poseSummary = summary.pose && typeof summary.pose === 'object' ? summary.pose : null;
  if (poseSummary) {
    const poseSection = document.createElement('section');
    poseSection.className = 'metrics-section';
    const poseHeading = document.createElement('h3');
    poseHeading.textContent = 'Pose indicators';
    poseSection.appendChild(poseHeading);
    const list = document.createElement('div');
    list.className = 'metrics-channels';
    const forecastCount = typeof poseSummary.forecasts === 'number' ? poseSummary.forecasts : 0;
    const forecastsRow = createMetricsRow('Forecasts', `${forecastCount}`);
    if (forecastsRow) {
      list.appendChild(forecastsRow);
    }
    const avgConfidence = formatPercent(poseSummary.averageConfidence ?? null);
    if (avgConfidence) {
      const avgConfidenceRow = createMetricsRow('Avg confidence', avgConfidence);
      if (avgConfidenceRow) {
        list.appendChild(avgConfidenceRow);
      }
    }
    const latest = poseSummary.lastForecast && typeof poseSummary.lastForecast === 'object' ? poseSummary.lastForecast : null;
    if (latest) {
      const parts = [];
      if (typeof latest.movingJointCount === 'number' && Number.isFinite(latest.movingJointCount)) {
        parts.push(`${latest.movingJointCount} joints`);
      }
      const latestRatio = formatPercent(latest.movingJointRatio ?? null);
      if (latestRatio) {
        parts.push(latestRatio);
      }
      if (parts.length > 0) {
        const latestRow = createMetricsRow('Latest movement', parts.join(' · '));
        if (latestRow) {
          list.appendChild(latestRow);
        }
      }
    }
    const threats = poseSummary.threats && typeof poseSummary.threats === 'object' ? poseSummary.threats : null;
    if (threats) {
      const maxThreat = threats.maxThreat && typeof threats.maxThreat === 'object' ? threats.maxThreat : null;
      const peak = maxThreat
        ? (() => {
            const label = maxThreat.label && typeof maxThreat.label === 'string' ? maxThreat.label : 'Threat';
            const score = formatPercent(maxThreat.threatScore ?? null);
            return score ? `${label} (${score})` : label;
          })()
        : 'No threat spikes';
      const peakRow = createMetricsRow('Peak threat', peak);
      if (peakRow) {
        list.appendChild(peakRow);
      }
      if (typeof threats.events === 'number' && threats.events > 0) {
        const averageThreat = formatPercent(threats.averageMaxThreatScore ?? null);
        const pieces = [];
        if (averageThreat) {
          pieces.push(`avg ${averageThreat}`);
        }
        if (typeof threats.totalDetections === 'number' && Number.isFinite(threats.totalDetections)) {
          pieces.push(`${threats.totalDetections} detections`);
        }
        if (pieces.length > 0) {
          const activityRow = createMetricsRow('Threat activity', pieces.join(' · '));
          if (activityRow) {
            list.appendChild(activityRow);
          }
        }
      }
    }
    poseSection.appendChild(list);
    threatSummaryContainer.appendChild(poseSection);
  }

  const severityEntries = Object.entries(summary.totals?.bySeverity ?? {});
  const detectorEntries = Object.entries(summary.totals?.byDetector ?? {});

  const severitySection = document.createElement('section');
  severitySection.className = 'metrics-section';
  const severityHeading = document.createElement('h3');
  severityHeading.textContent = 'Severity distribution';
  severitySection.appendChild(severityHeading);
  if (severityEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No severity data yet.';
    severitySection.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'metrics-channels';
    severityEntries
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .forEach(([level, count]) => {
        const row = createMetricsRow(level, `${count} events`);
        if (row) {
          list.appendChild(row);
        }
      });
    severitySection.appendChild(list);
  }
  threatSummaryContainer.appendChild(severitySection);

  const detectorSection = document.createElement('section');
  detectorSection.className = 'metrics-section';
  const detectorHeading = document.createElement('h3');
  detectorHeading.textContent = 'Top detectors';
  detectorSection.appendChild(detectorHeading);
  if (detectorEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No detector events yet.';
    detectorSection.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'metrics-channels';
    detectorEntries
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 5)
      .forEach(([detector, count]) => {
        const row = createMetricsRow(detector, `${count} events`);
        if (row) {
          list.appendChild(row);
        }
      });
    detectorSection.appendChild(list);
  }
  threatSummaryContainer.appendChild(detectorSection);
}

function renderChannelStatus() {
  if (!channelStatusContainer) {
    return;
  }
  if (!isDomAvailable()) {
    return;
  }
  channelStatusContainer.innerHTML = '';
  const summary = state.summary;
  const digest = state.digest;
  if (!summary && !digest) {
    if (channelStatusEmpty) {
      channelStatusEmpty.hidden = false;
    }
    return;
  }
  if (channelStatusEmpty) {
    channelStatusEmpty.hidden = true;
  }

  const channelMap = new Map();
  if (summary?.channels) {
    summary.channels.forEach(channel => {
      const channelId = normalizeChannelId(channel.id);
      if (!channelId) {
        return;
      }
      channelMap.set(channelId, {
        id: channelId,
        events: channel.total,
        lastEventTs: channel.lastEventTs,
        severity: channel.bySeverity ?? {},
        snapshots: channel.snapshots ?? 0,
        restarts: 0,
        lastRestartAt: null,
        lastRestartReason: null,
        watchdogBackoffMs: null,
        healthSeverity: 'none',
        healthReason: null,
        healthDegradedSince: null
      });
    });
  }
  const pipelineChannels = digest?.pipelines?.ffmpeg?.channels ?? [];
  pipelineChannels.forEach(entry => {
    const channelId = normalizeChannelId(entry.channel);
    if (!channelId) {
      return;
    }
    const existing = channelMap.get(channelId) ?? {
      id: channelId,
      events: 0,
      lastEventTs: null,
      severity: {},
      snapshots: 0,
      restarts: 0,
      lastRestartAt: null,
      lastRestartReason: null,
      watchdogBackoffMs: null,
      healthSeverity: 'none',
      healthReason: null,
      healthDegradedSince: null
    };
    existing.restarts = entry.restarts ?? 0;
    existing.lastRestartAt = entry.lastRestartAt ?? null;
    existing.lastRestartReason = entry.lastRestart?.reason ?? null;
    existing.watchdogBackoffMs = entry.watchdogBackoffMs ?? null;
    existing.healthSeverity = entry.health?.severity ?? existing.healthSeverity ?? 'none';
    existing.healthReason = entry.health?.reason ?? existing.healthReason ?? null;
    existing.healthDegradedSince = entry.health?.degradedSince ?? existing.healthDegradedSince ?? null;
    channelMap.set(channelId, existing);
  });

  const entries = Array.from(channelMap.values()).sort((a, b) => {
    if ((b.events ?? 0) !== (a.events ?? 0)) {
      return (b.events ?? 0) - (a.events ?? 0);
    }
    const lastA = a.lastEventTs ?? 0;
    const lastB = b.lastEventTs ?? 0;
    if (lastB !== lastA) {
      return lastB - lastA;
    }
    return a.id.localeCompare(b.id);
  });

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No channel activity yet.';
    channelStatusContainer.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.className = 'metrics-channels';
  entries.slice(0, 6).forEach(entry => {
    const parts = [`${entry.events} events`];
    const criticalCount = entry.severity?.critical ?? 0;
    if (criticalCount > 0) {
      parts.push(`${criticalCount} critical`);
    }
    if (entry.snapshots > 0) {
      parts.push(`${entry.snapshots} snapshots`);
    }
    if ((entry.restarts ?? 0) > 0) {
      const reason = entry.lastRestartReason ?? 'restart';
      parts.push(`${entry.restarts} restarts (${reason})`);
    }
    if (typeof entry.watchdogBackoffMs === 'number' && entry.watchdogBackoffMs > 0) {
      parts.push(`${Math.round(entry.watchdogBackoffMs)}ms watchdog delay`);
    }
    const severity = entry.healthSeverity ?? 'none';
    let tooltip;
    const rowOptions = {};
    if (severity && severity !== 'none') {
      const label = severity.charAt(0).toUpperCase() + severity.slice(1);
      const sinceText = entry.healthDegradedSince ? formatRelativeTime(entry.healthDegradedSince) : null;
      const healthDetail = [`health ${severity}`];
      if (sinceText) {
        healthDetail.push(`since ${sinceText}`);
      }
      parts.push(healthDetail.join(' '));
      const badge = {
        label,
        className: `severity-${severity}`
      };
      const tooltipParts = [];
      if (entry.healthReason) {
        tooltipParts.push(entry.healthReason);
      }
      if (entry.healthDegradedSince) {
        const degradedTs = Date.parse(entry.healthDegradedSince);
        if (Number.isFinite(degradedTs)) {
          tooltipParts.push(`Degraded since ${new Date(degradedTs).toLocaleString()}`);
        }
      }
      if (tooltipParts.length > 0) {
        tooltip = tooltipParts.join(' • ');
      }
      rowOptions.badge = badge;
    }
    if (tooltip) {
      rowOptions.tooltip = tooltip;
    }
    const detail = parts.join(' · ');
    if (Object.keys(rowOptions).length > 0) {
      const row = createMetricsRow(entry.id, detail, rowOptions);
      if (row) {
        list.appendChild(row);
      }
    } else {
      const row = createMetricsRow(entry.id, detail);
      if (row) {
        list.appendChild(row);
      }
    }
  });
  channelStatusContainer.appendChild(list);
}

function renderPipelineSection(label, snapshot) {
  if (!snapshot) {
    return null;
  }
  if (!isDomAvailable()) {
    return null;
  }
  const section = document.createElement('section');
  section.className = 'metrics-section';
  const heading = document.createElement('h3');
  heading.textContent = label;
  section.appendChild(heading);

  const summary = document.createElement('div');
  summary.className = 'metrics-summary';
  const total = document.createElement('strong');
  const restartLabel = snapshot.restarts === 1 ? 'restart' : 'restarts';
  total.textContent = `${snapshot.restarts} ${restartLabel}`;
  summary.appendChild(total);
  const last = document.createElement('span');
  last.textContent = snapshot.lastRestartAt
    ? `Last restart ${formatRelativeTime(snapshot.lastRestartAt)}`
    : 'No restarts yet';
  summary.appendChild(last);
  section.appendChild(summary);

  const channels = Object.entries(snapshot.byChannel ?? {});
  if (channels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No channel restarts recorded yet.';
    section.appendChild(empty);
    return section;
  }

  const list = document.createElement('div');
  list.className = 'metrics-channels';
  channels
    .sort((a, b) => {
      const restartDiff = (b[1].restarts ?? 0) - (a[1].restarts ?? 0);
      if (restartDiff !== 0) {
        return restartDiff;
      }
      const lastA = a[1].lastRestartAt ? Date.parse(a[1].lastRestartAt) : 0;
      const lastB = b[1].lastRestartAt ? Date.parse(b[1].lastRestartAt) : 0;
      if (lastB !== lastA) {
        return lastB - lastA;
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 5)
    .forEach(([channel, info]) => {
      const item = document.createElement('div');
      item.className = 'metrics-channel';
      const name = document.createElement('span');
      name.textContent = channel;
      const details = document.createElement('small');
      if (info.restarts > 0) {
        const reason = info.lastRestart?.reason ?? 'unknown reason';
        const when = formatRelativeTime(info.lastRestartAt);
        details.textContent = `${info.restarts} ${info.restarts === 1 ? 'restart' : 'restarts'}, last ${when} (${reason})`;
      } else {
        details.textContent = 'No restarts yet';
      }
      item.append(name, details);
      list.appendChild(item);
    });
  section.appendChild(list);
  return section;
}

function renderRetentionSection(retention) {
  if (!retention) {
    return null;
  }
  if (!isDomAvailable()) {
    return null;
  }
  const section = document.createElement('section');
  section.className = 'metrics-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Retention';
  section.appendChild(heading);

  const summary = document.createElement('div');
  summary.className = 'metrics-summary';
  const totals = retention.totals ?? { archivedSnapshots: 0, prunedArchives: 0, removedEvents: 0 };
  const totalsLine = document.createElement('strong');
  const removed = typeof totals.removedEvents === 'number' ? totals.removedEvents : 0;
  const archived = typeof totals.archivedSnapshots === 'number' ? totals.archivedSnapshots : 0;
  const pruned = typeof totals.prunedArchives === 'number' ? totals.prunedArchives : 0;
  totalsLine.textContent = `${removed} removed · ${archived} archived · ${pruned} pruned`;
  summary.appendChild(totalsLine);
  const runsLine = document.createElement('span');
  if (retention.runs > 0) {
    const runLabel = retention.runs === 1 ? 'run' : 'runs';
    const lastRun = retention.lastRunAt ? `, last ${formatRelativeTime(retention.lastRunAt)}` : '';
    runsLine.textContent = `${retention.runs} ${runLabel}${lastRun}`;
  } else {
    runsLine.textContent = 'No retention runs yet';
  }
  summary.appendChild(runsLine);
  section.appendChild(summary);

  const cameras = Object.entries(retention.totalsByCamera ?? {});
  if (cameras.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No snapshot archives recorded yet.';
    section.appendChild(empty);
    return section;
  }

  const list = document.createElement('div');
  list.className = 'metrics-channels';
  cameras
    .sort((a, b) => {
      const archivedDiff = (b[1].archivedSnapshots ?? 0) - (a[1].archivedSnapshots ?? 0);
      if (archivedDiff !== 0) {
        return archivedDiff;
      }
      const prunedDiff = (b[1].prunedArchives ?? 0) - (a[1].prunedArchives ?? 0);
      if (prunedDiff !== 0) {
        return prunedDiff;
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 4)
    .forEach(([camera, totals]) => {
      const item = document.createElement('div');
      item.className = 'metrics-channel';
      const name = document.createElement('span');
      name.textContent = camera;
      const details = document.createElement('small');
      const parts = [`${totals.archivedSnapshots} archived`];
      if ((totals.prunedArchives ?? 0) > 0) {
        parts.push(`${totals.prunedArchives} pruned`);
      }
      details.textContent = parts.join(', ');
      item.append(name, details);
      list.appendChild(item);
    });
  section.appendChild(list);
  return section;
}

function updatePipelineWidget(payload) {
  if (!pipelineMetricsContainer || !isDomAvailable()) {
    return;
  }
  if (pipelineMetricsEmpty) {
    pipelineMetricsEmpty.remove();
  }

  if (!payload || typeof payload !== 'object') {
    renderMetricsMessage('Metrics unavailable.');
    return;
  }

  pipelineMetricsContainer.innerHTML = '';

  const updatedAt = document.createElement('p');
  updatedAt.className = 'meta';
  updatedAt.textContent = `Updated ${formatRelativeTime(payload.fetchedAt ?? Date.now())}`;
  pipelineMetricsContainer.appendChild(updatedAt);

  let sectionsRendered = 0;
  const pipelineEntries = [
    ['Video streams', payload.pipelines?.ffmpeg],
    ['Audio streams', payload.pipelines?.audio]
  ];
  pipelineEntries.forEach(([label, snapshot]) => {
    const section = renderPipelineSection(label, snapshot);
    if (section) {
      pipelineMetricsContainer.appendChild(section);
      sectionsRendered += 1;
    }
  });

  const retentionSection = renderRetentionSection(payload.retention);
  if (retentionSection) {
    pipelineMetricsContainer.appendChild(retentionSection);
    sectionsRendered += 1;
  }

  if (sectionsRendered === 0) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No pipeline metrics available yet.';
    pipelineMetricsContainer.appendChild(empty);
  }
}

async function refreshPipelineMetrics() {
  if (!pipelineMetricsContainer || state.metrics.pending || !isDomAvailable()) {
    return;
  }
  state.metrics.pending = true;
  pipelineMetricsContainer.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/metrics/pipelines');
    if (!response.ok) {
      throw new Error(`Failed to load metrics (${response.status})`);
    }
    const payload = await response.json();
    state.metrics.data = payload;
    state.metrics.lastFetched = Date.now();
    if (isDomAvailable()) {
      updatePipelineWidget(payload);
    }
  } catch (error) {
    console.error('Failed to load pipeline metrics', error);
    state.metrics.data = null;
    renderMetricsMessage('Failed to load metrics.');
  } finally {
    state.metrics.pending = false;
    pipelineMetricsContainer.setAttribute('aria-busy', 'false');
  }
}

function pruneSelectedChannels() {
  const selected = getSelectedChannels();
  let changed = false;
  for (const channel of Array.from(selected)) {
    if (!state.channelStats.has(channel)) {
      selected.delete(channel);
      changed = true;
    }
  }
  if (changed) {
    renderEvents();
  }
}

function rebuildChannelsFromEvents() {
  const stats = new Map();
  state.events.forEach(event => {
    const channel = getEventChannel(event);
    if (!channel) {
      return;
    }
    const ts = typeof event.ts === 'number' ? event.ts : Date.now();
    const existing = stats.get(channel);
    if (existing) {
      if (ts < existing.firstSeen) {
        existing.firstSeen = ts;
      }
      if (ts > existing.lastSeen) {
        existing.lastSeen = ts;
      }
    } else {
      stats.set(channel, { firstSeen: ts, lastSeen: ts });
    }
  });
  state.channelStats = stats;
  pruneSelectedChannels();
  updateChannelFilterControls();
}

function createPoseSummaryAccumulator() {
  return {
    forecasts: 0,
    confidenceTotal: 0,
    confidenceCount: 0,
    lastForecast: null,
    threatEvents: 0,
    threatScoreTotal: 0,
    threatDetections: 0,
    highestThreat: null
  };
}

function accumulatePoseSummaryFromEvent(accumulator, event) {
  const meta = (event && event.meta && typeof event.meta === 'object') ? event.meta : {};
  const ts = normalizeTimestamp(event?.ts);
  const forecast = extractPoseForecast(meta);
  if (forecast) {
    accumulator.forecasts += 1;
    if (typeof forecast.confidence === 'number') {
      accumulator.confidenceTotal += forecast.confidence;
      accumulator.confidenceCount += 1;
    }
    const shouldReplace = !accumulator.lastForecast ||
      (typeof ts === 'number' && (accumulator.lastForecast.ts ?? -Infinity) <= ts);
    if (shouldReplace) {
      accumulator.lastForecast = {
        ts: typeof ts === 'number' ? ts : null,
        eventId: typeof event?.id === 'number' ? event.id : null,
        confidence: typeof forecast.confidence === 'number' ? forecast.confidence : null,
        movingJointCount:
          typeof forecast.movingJointCount === 'number' && Number.isFinite(forecast.movingJointCount)
            ? forecast.movingJointCount
            : null,
        movingJointRatio:
          typeof forecast.movingJointRatio === 'number' && Number.isFinite(forecast.movingJointRatio)
            ? forecast.movingJointRatio
            : null,
        detector: typeof event?.detector === 'string' ? event.detector : null,
        severity: typeof event?.severity === 'string' ? event.severity : null
      };
    }
  }

  const threat = extractPoseThreatSummary(meta);
  if (threat) {
    accumulator.threatEvents += 1;
    if (typeof threat.maxThreatScore === 'number') {
      accumulator.threatScoreTotal += threat.maxThreatScore;
      const current = accumulator.highestThreat;
      if (!current || current.threatScore < threat.maxThreatScore) {
        accumulator.highestThreat = {
          threatScore: threat.maxThreatScore,
          label: typeof threat.maxThreatLabel === 'string' ? threat.maxThreatLabel : null,
          eventId: typeof event?.id === 'number' ? event.id : null,
          ts: typeof ts === 'number' ? ts : null,
          detector: typeof event?.detector === 'string' ? event.detector : null,
          severity: typeof event?.severity === 'string' ? event.severity : null
        };
      }
    }
    if (typeof threat.totalDetections === 'number') {
      accumulator.threatDetections += threat.totalDetections;
    }
  }
}

function finalizePoseSummaryFromAccumulator(accumulator) {
  if (
    accumulator.forecasts === 0 &&
    accumulator.confidenceCount === 0 &&
    accumulator.threatEvents === 0 &&
    !accumulator.highestThreat
  ) {
    return null;
  }

  const summary = {
    forecasts: accumulator.forecasts
  };

  if (accumulator.confidenceCount > 0) {
    summary.averageConfidence = accumulator.confidenceTotal / accumulator.confidenceCount;
  }

  if (accumulator.lastForecast) {
    summary.lastForecast = {
      ts: accumulator.lastForecast.ts,
      eventId: accumulator.lastForecast.eventId,
      confidence: accumulator.lastForecast.confidence,
      movingJointCount: accumulator.lastForecast.movingJointCount,
      movingJointRatio: accumulator.lastForecast.movingJointRatio,
      detector: accumulator.lastForecast.detector,
      severity: accumulator.lastForecast.severity
    };
  }

  if (accumulator.threatEvents > 0 || accumulator.highestThreat) {
    summary.threats = {
      events: accumulator.threatEvents,
      averageMaxThreatScore:
        accumulator.threatEvents > 0 ? accumulator.threatScoreTotal / accumulator.threatEvents : null,
      totalDetections: accumulator.threatDetections,
      maxThreat: accumulator.highestThreat
        ? {
            label: accumulator.highestThreat.label,
            threatScore: accumulator.highestThreat.threatScore,
            eventId: accumulator.highestThreat.eventId,
            ts: accumulator.highestThreat.ts,
            detector: accumulator.highestThreat.detector,
            severity: accumulator.highestThreat.severity
          }
        : null
    };
  }

  return summary;
}

function extractPoseForecast(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const forecast = meta.poseForecast;
  if (!forecast || typeof forecast !== 'object') {
    return null;
  }
  return {
    confidence: typeof forecast.confidence === 'number' ? forecast.confidence : null,
    movingJointCount: typeof forecast.movingJointCount === 'number' ? forecast.movingJointCount : null,
    movingJointRatio: typeof forecast.movingJointRatio === 'number' ? forecast.movingJointRatio : null
  };
}

function extractPoseThreatSummary(meta) {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const summary = meta.poseThreatSummary || meta.threats;
  if (!summary || typeof summary !== 'object') {
    return null;
  }
  return {
    maxThreatScore: typeof summary.maxThreatScore === 'number' ? summary.maxThreatScore : null,
    maxThreatLabel:
      typeof summary.maxThreatLabel === 'string'
        ? summary.maxThreatLabel
        : summary.maxThreatLabel === null
        ? null
        : undefined,
    totalDetections:
      typeof summary.totalDetections === 'number' ? summary.totalDetections : undefined
  };
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.min(Math.max(value, 0), 1);
  return `${Math.round(clamped * 100)}%`;
}

function computeSummaryFromEvents(events) {
  const totalsByDetector = {};
  const totalsBySeverity = {};
  const channelMap = new Map();
  const poseAccumulator = createPoseSummaryAccumulator();

  events.forEach(event => {
    const detector = event.detector ?? 'unknown';
    const severity = event.severity ?? 'info';
    totalsByDetector[detector] = (totalsByDetector[detector] ?? 0) + 1;
    totalsBySeverity[severity] = (totalsBySeverity[severity] ?? 0) + 1;
    const meta = event.meta ?? {};
    accumulatePoseSummaryFromEvent(poseAccumulator, event);
    const resolvedChannels = Array.isArray(meta.resolvedChannels)
      ? meta.resolvedChannels.filter(channel => typeof channel === 'string')
      : [getEventChannel(event)].filter(Boolean);
    const channels = resolvedChannels.length > 0 ? resolvedChannels : ['unassigned'];
    const ts = typeof event.ts === 'number' ? event.ts : Date.now();
    const hasSnapshot = Boolean(meta.snapshotUrl || meta.snapshot || meta.faceSnapshotUrl);

    channels.forEach(channel => {
      const existing = channelMap.get(channel) ?? {
        id: channel,
        total: 0,
        byDetector: {},
        bySeverity: {},
        lastEventTs: null,
        snapshots: 0
      };
      existing.total += 1;
      existing.byDetector[detector] = (existing.byDetector[detector] ?? 0) + 1;
      existing.bySeverity[severity] = (existing.bySeverity[severity] ?? 0) + 1;
      existing.lastEventTs = existing.lastEventTs ? Math.max(existing.lastEventTs, ts) : ts;
      if (hasSnapshot) {
        existing.snapshots += 1;
      }
      channelMap.set(channel, existing);
    });
  });

  const summary = {
    totals: {
      byDetector: totalsByDetector,
      bySeverity: totalsBySeverity
    },
    channels: Array.from(channelMap.values())
  };

  const poseSummary = finalizePoseSummaryFromAccumulator(poseAccumulator);
  if (poseSummary) {
    summary.pose = poseSummary;
  }

  return summary;
}

function updateSummaries(serverSummary) {
  if (serverSummary) {
    state.summary = serverSummary;
  } else {
    state.summary = computeSummaryFromEvents(state.events);
  }
  applyPoseSummary(state.summary);
  renderThreatSummary(state.summary);
  renderChannelStatus();
}

function applyPoseSummary(summary) {
  const pose = summary && typeof summary === 'object' ? summary.pose : null;
  if (!pose || typeof pose !== 'object') {
    state.pose.lastForecast = null;
    state.pose.lastThreat = null;
    state.pose.lastUpdated = null;
    updatePoseWidget();
    return;
  }

  const forecast = pose.lastForecast && typeof pose.lastForecast === 'object' ? pose.lastForecast : null;
  state.pose.lastForecast = forecast
    ? {
        confidence:
          typeof forecast.confidence === 'number' && Number.isFinite(forecast.confidence)
            ? forecast.confidence
            : null,
        movingJointCount:
          typeof forecast.movingJointCount === 'number' && Number.isFinite(forecast.movingJointCount)
            ? forecast.movingJointCount
            : null,
        movingJointRatio:
          typeof forecast.movingJointRatio === 'number' && Number.isFinite(forecast.movingJointRatio)
            ? forecast.movingJointRatio
            : null,
        eventId: typeof forecast.eventId === 'number' ? forecast.eventId : null,
        ts: normalizeTimestamp(forecast.ts)
      }
    : null;

  const threats = pose.threats && typeof pose.threats === 'object' ? pose.threats : null;
  const maxThreat = threats && typeof threats.maxThreat === 'object' ? threats.maxThreat : null;
  state.pose.lastThreat = maxThreat
    ? {
        label: typeof maxThreat.label === 'string' ? maxThreat.label : null,
        threatScore:
          typeof maxThreat.threatScore === 'number' && Number.isFinite(maxThreat.threatScore)
            ? maxThreat.threatScore
            : null,
        eventId: typeof maxThreat.eventId === 'number' ? maxThreat.eventId : null,
        ts: normalizeTimestamp(maxThreat.ts)
      }
    : null;

  const forecastTs = state.pose.lastForecast?.ts;
  const threatTs = state.pose.lastThreat?.ts;
  state.pose.lastUpdated = typeof forecastTs === 'number' && Number.isFinite(forecastTs)
    ? forecastTs
    : typeof threatTs === 'number' && Number.isFinite(threatTs)
    ? threatTs
    : null;

  updatePoseWidget();
}

function setMetricsDigest(digest) {
  state.digest = digest ?? null;
  setHealthStatus(computeHealthStatus(state.digest));
  renderChannelStatus();
  if (digest && typeof digest === 'object') {
    state.metrics.data = digest;
    state.metrics.lastFetched = Date.now();
    const hasRetention = digest.retention && typeof digest.retention === 'object';
    const pipelineSnapshot = digest.pipelines && typeof digest.pipelines === 'object'
      ? digest.pipelines
      : null;
    const hasPipelines = !!(
      pipelineSnapshot?.ffmpeg || pipelineSnapshot?.audio
    );
    if (hasRetention || hasPipelines) {
      updatePipelineWidget(digest);
    }
  }
}

function setHealthStatus(status) {
  const label = status || 'Unknown';
  state.stream.health = label;
  if (streamHealth) {
    streamHealth.textContent = label;
  }
}

function computeHealthStatus(digest) {
  if (!digest || typeof digest !== 'object') {
    return 'Unknown';
  }
  const pipelineDigest = digest.pipelines;
  const ffmpeg = pipelineDigest?.ffmpeg;
  if (!ffmpeg || typeof ffmpeg !== 'object') {
    return 'Unknown';
  }

  const entries = [];
  if (Array.isArray(ffmpeg.channels)) {
    entries.push(...ffmpeg.channels.filter(Boolean));
  }
  if (ffmpeg.byChannel && typeof ffmpeg.byChannel === 'object') {
    entries.push(...Object.values(ffmpeg.byChannel).filter(Boolean));
  }

  const now = Date.now();
  const hasRecentRestart = entries.some(entry => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const restarts = typeof entry.restarts === 'number' ? entry.restarts : 0;
    if (restarts > 0) {
      const ts = typeof entry.lastRestartAt === 'string' ? Date.parse(entry.lastRestartAt) : NaN;
      if (Number.isFinite(ts) && now - ts >= 0 && now - ts < 5 * 60_000) {
        return true;
      }
    }
    const lastRestart = entry.lastRestart;
    if (lastRestart && typeof lastRestart === 'object') {
      const ts =
        typeof lastRestart.at === 'string'
          ? Date.parse(lastRestart.at)
          : typeof lastRestart.at === 'number'
          ? lastRestart.at
          : NaN;
      if (Number.isFinite(ts) && now - ts >= 0 && now - ts < 5 * 60_000) {
        return true;
      }
    }
    return false;
  });

  if (!hasRecentRestart && typeof ffmpeg.lastRestartAt === 'string') {
    const ts = Date.parse(ffmpeg.lastRestartAt);
    if (Number.isFinite(ts) && now - ts >= 0 && now - ts < 5 * 60_000) {
      return 'Degraded';
    }
  }

  return hasRecentRestart ? 'Degraded' : 'Healthy';
}

function updateChannelFilterControls() {
  if (!channelFilterOptions || !channelFilterEmpty) {
    return;
  }
  if (!isDomAvailable()) {
    return;
  }

  const selected = getSelectedChannels();
  const channels = Array.from(state.channelStats.entries()).sort(
    (a, b) => b[1].lastSeen - a[1].lastSeen
  );
  channelFilterOptions.textContent = '';

  if (channels.length === 0) {
    channelFilterEmpty.hidden = false;
    channelFilter?.setAttribute('aria-busy', 'false');
    return;
  }

  channelFilterEmpty.hidden = true;
  channelFilter?.setAttribute('aria-busy', 'false');

  const fragment = document.createDocumentFragment();
  channels.forEach(([channel]) => {
    const label = document.createElement('label');
    label.className = 'channel-chip';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'channel-filter-item';
    input.value = channel;
    input.checked = selected.has(channel);
    input.setAttribute('aria-label', `Filter events for channel ${channel}`);

    input.addEventListener('change', () => {
      if (input.checked) {
        selected.add(channel);
      } else {
        selected.delete(channel);
      }
      renderEvents();
      const active = state.events.find(item => item.__key === state.activeId);
      if (!active || !matchesFilters(active)) {
        clearPreview();
      }
    });

    const text = document.createElement('span');
    text.textContent = channel;

    label.appendChild(input);
    label.appendChild(text);
    fragment.appendChild(label);
  });

  channelFilterOptions.appendChild(fragment);
}

function subscribe() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  resetStreamStats();
  setConnectionState('connecting');
  channelFilter?.setAttribute('aria-busy', 'true');

  const params = buildQueryParams();
  params.set('retry', String(state.reconnectDelayMs));
  params.set('faces', '1');
  params.set('snapshots', '1');
  params.set('snapshotLimit', '10');
  if (typeof state.lastEventId === 'number' && Number.isFinite(state.lastEventId)) {
    params.set('lastEventId', String(state.lastEventId));
    params.set('backlog', '1');
  }
  const source = new EventSource(`/api/events/stream?${params.toString()}`);
  state.eventSource = source;

  source.onopen = () => {
    setConnectionState('connected');
    channelFilter?.setAttribute('aria-busy', 'false');
  };

  source.addEventListener('stream-status', event => {
    try {
      const payload = JSON.parse(event.data);
      if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'retryMs')) {
        const normalized = clampReconnectDelay(payload?.retryMs);
        if (normalized !== null) {
          state.reconnectDelayMs = normalized;
        }
        state.retryHint = null;
      }
      if (payload?.status) {
        setConnectionState(String(payload.status));
      }
    } catch (error) {
      console.debug('Failed to parse stream-status payload', error);
    }
  });

  source.addEventListener('retry-hint', event => {
    try {
      const payload = JSON.parse(event.data);
      updateRetryHint(payload);
      const banner = getOfflineBannerElement();
      if (banner && !banner.hidden) {
        showOfflineBanner(state.reconnectDelayMs);
      }
    } catch (error) {
      console.debug('Failed to parse retry-hint payload', error);
    }
  });

  source.addEventListener('heartbeat', event => {
    try {
      const payload = JSON.parse(event.data);
      recordHeartbeat(typeof payload?.ts === 'number' ? payload.ts : Date.now());
    } catch (error) {
      recordHeartbeat(Date.now());
      console.debug('Failed to parse heartbeat payload', error);
    }
  });

  source.addEventListener('faces', event => {
    try {
      const payload = JSON.parse(event.data);
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const faces = Array.isArray(payload.faces) ? payload.faces : [];
      let touched = false;
      faces.forEach(face => {
        if (!face || typeof face !== 'object') {
          return;
        }
        const metadata = face.metadata && typeof face.metadata === 'object' ? face.metadata : null;
        if (!metadata) {
          return;
        }
        const candidate =
          typeof metadata.channel === 'string'
            ? metadata.channel
            : typeof metadata.camera === 'string'
            ? metadata.camera
            : '';
        if (candidate) {
          touched = true;
          registerChannel(candidate);
        }
      });
      if (!touched) {
        updateChannelFilterControls();
      }
    } catch (error) {
      console.debug('Failed to parse faces payload', error);
    }
  });

  source.addEventListener('metrics', event => {
    try {
      const payload = JSON.parse(event.data);
      setMetricsDigest(payload);
    } catch (error) {
      console.debug('Failed to parse metrics payload', error);
    }
  });

  source.addEventListener('warning', event => {
    try {
      const payload = JSON.parse(event.data);
      const warning = normalizeWarning(payload);
      if (warning) {
        appendWarning(warning);
        recordSnapshotEvent();
      }
    } catch (error) {
      console.debug('Failed to parse warning payload', error);
    }
  });

  source.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      recordLastEventId(event.lastEventId ?? null);
      if (payload && typeof payload === 'object') {
        recordLastEventId(payload.id);
      }
      const keyed = insertEvent(payload);
      recordStreamEvent(typeof payload?.ts === 'number' ? payload.ts : Date.now());
      const meta = payload?.meta ?? {};
      if (meta && (meta.snapshotUrl || meta.faceSnapshotUrl || meta.snapshot)) {
        recordSnapshotEvent();
      }
      if (!state.activeId && matchesFilters(keyed)) {
        setActiveEvent(keyed.__key);
      }
    } catch (error) {
      console.error('Failed to parse event payload', error);
    }
  };

  source.onerror = () => {
    setConnectionState('disconnected');
    source.close();
    state.eventSource = null;
    channelFilter?.setAttribute('aria-busy', 'false');
    const delayMs = pickReconnectDelay();
    state.reconnectDelayMs = delayMs;
    showOfflineBanner(delayMs);
    setTimeout(() => {
      setConnectionState('reconnecting');
      subscribe();
    }, delayMs);
  };
}

function syncFiltersFromForm() {
  const formData = new FormData(filtersForm);
  state.filters.source = (formData.get('source') ?? '').toString().trim();
  state.filters.camera = (formData.get('camera') ?? '').toString().trim();
  state.filters.severity = (formData.get('severity') ?? '').toString().trim();
  state.filters.search = (formData.get('search') ?? '').toString().trim();
  const snapshot = (formData.get('snapshot') ?? '').toString().trim();
  state.filters.snapshot = snapshot === 'with' || snapshot === 'without' ? snapshot : '';
  state.filters.from = (formData.get('from') ?? '').toString();
  state.filters.to = (formData.get('to') ?? '').toString();
  state.filters.channelQuery = (formData.get('channels') ?? '').toString().trim();
}

function resetFilters() {
  state.filters.source = '';
  state.filters.camera = '';
  state.filters.severity = '';
  state.filters.from = '';
  state.filters.to = '';
  state.filters.search = '';
  state.filters.snapshot = '';
  state.filters.channelQuery = '';
  getSelectedChannels().clear();
  filtersForm.reset();
  clearPreview();
  rebuildChannelsFromEvents();
  loadInitial();
}

filtersForm.addEventListener('submit', event => {
  event.preventDefault();
  syncFiltersFromForm();
  clearPreview();
  loadInitial();
  subscribe();
});

resetButton.addEventListener('click', () => {
  resetFilters();
  subscribe();
});

initializeResponsiveLayout();
updateStreamWidget();
renderWarnings();
const METRICS_REFRESH_INTERVAL = 30_000;
refreshPipelineMetrics();
setInterval(() => {
  void refreshPipelineMetrics();
}, METRICS_REFRESH_INTERVAL);

loadInitial().then(() => {
  renderEvents();
  renderWarnings();
});
subscribe();

if (typeof window !== 'undefined') {
  // Expose state for test harness assertions.
  // @ts-expect-error augment window for dashboard introspection
  window.__guardianDashboardState = state;
}

function buildQueryParams() {
  const params = new URLSearchParams();
  if (state.filters.source) params.set('source', state.filters.source);
  if (state.filters.camera) params.set('camera', state.filters.camera);
  if (state.filters.severity) params.set('severity', state.filters.severity);
  if (state.filters.search) params.set('search', state.filters.search);
  if (state.filters.snapshot) params.set('snapshot', state.filters.snapshot);
  if (state.filters.from) params.set('from', state.filters.from);
  if (state.filters.to) params.set('to', state.filters.to);
  if (state.filters.channelQuery) params.set('channels', state.filters.channelQuery);
  const selectedChannels = Array.from(getSelectedChannels());
  selectedChannels.forEach(channel => {
    params.append('channel', channel);
  });
  return params;
}

function parseDateFilter(value) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function buildSnapshotCacheKey(event) {
  const meta = event.meta ?? {};
  const hash = typeof meta.snapshotHash === 'string' ? meta.snapshotHash : '';
  const ts = typeof meta.snapshotTs === 'number' ? meta.snapshotTs : event.ts;
  const channel = getEventChannel(event);
  const camera =
    typeof meta.camera === 'string'
      ? meta.camera
      : state.filters.camera || (typeof event.source === 'string' ? event.source : '');
  return [ts, hash, camera, channel].join(':');
}
