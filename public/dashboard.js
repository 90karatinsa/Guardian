const list = document.getElementById('events');
const filtersForm = document.getElementById('filters');
const resetButton = document.getElementById('reset-filters');
const previewEmpty = document.getElementById('preview-empty');
const previewFigure = document.getElementById('preview-figure');
const previewImage = document.getElementById('preview-image');
const previewCaption = document.getElementById('preview-caption');
const streamState = document.getElementById('stream-state');
const streamHeartbeats = document.getElementById('stream-heartbeats');
const streamEvents = document.getElementById('stream-events');
const streamUpdated = document.getElementById('stream-updated');
const channelFilter = document.getElementById('channel-filter');
const channelFilterOptions = document.getElementById('channel-filter-options');
const channelFilterEmpty = document.getElementById('channel-filter-empty');

if (previewImage) {
  previewImage.addEventListener('load', () => {
    previewImage.dataset.state = 'loaded';
  });
  previewImage.addEventListener('error', () => {
    previewImage.dataset.state = 'error';
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
    channels: new Set()
  },
  activeId: null,
  eventSource: null,
  reconnectDelayMs: 5000,
  stream: {
    heartbeats: 0,
    events: 0,
    lastUpdate: null,
    status: 'connecting'
  },
  channelStats: new Map()
};

function getSelectedChannels() {
  if (!(state.filters.channels instanceof Set)) {
    state.filters.channels = new Set();
  }
  return state.filters.channels;
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

function getEventChannel(event) {
  const meta = event.meta ?? {};
  if (typeof meta.channel === 'string' && meta.channel) {
    return meta.channel;
  }
  if (typeof meta.camera === 'string' && meta.camera) {
    return meta.camera;
  }
  if (typeof event.source === 'string' && event.source) {
    return event.source;
  }
  return '';
}

function matchesFilters(event) {
  const meta = event.meta ?? {};
  const resolvedChannel = getEventChannel(event);
  const metaChannel = typeof meta.channel === 'string' ? meta.channel : '';
  const cameraMeta = typeof meta.camera === 'string' ? meta.camera : '';
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';
  const ts = typeof event.ts === 'number' ? event.ts : Date.now();
  const selectedChannels = getSelectedChannels();

  if (state.filters.source && event.source !== state.filters.source) {
    return false;
  }
  if (state.filters.camera) {
    const cameraMatches =
      event.source === state.filters.camera ||
      cameraMeta === state.filters.camera ||
      resolvedChannel === state.filters.camera;
    if (!cameraMatches) {
      return false;
    }
  }
  if (selectedChannels instanceof Set && selectedChannels.size > 0) {
    if (!resolvedChannel || !selectedChannels.has(resolvedChannel)) {
      return false;
    }
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
      metaChannel,
      resolvedChannel,
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
  previewCaption.textContent = `${description} — ${timestamp}`;

  if (event.meta?.snapshot) {
    if (typeof event.id === 'number') {
      const cacheKey = encodeURIComponent(buildSnapshotCacheKey(event));
      previewImage.src = `/api/events/${event.id}/snapshot?cacheBust=${cacheKey}`;
    } else {
      const cacheKey = encodeURIComponent(buildSnapshotCacheKey(event));
      previewImage.src = `${event.meta.snapshot}?cacheBust=${cacheKey}`;
    }
    previewImage.dataset.channel = getEventChannel(event) || '';
    previewImage.dataset.state = 'loading';
    previewImage.alt = `Snapshot for ${description}`;
    previewFigure.hidden = false;
    previewEmpty.hidden = true;
  } else {
    previewFigure.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = 'No snapshot is available for the selected event.';
  }
}

function clearPreview() {
  state.activeId = null;
  previewFigure.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'Select an event to view the latest snapshot.';
  if (previewImage) {
    previewImage.dataset.channel = '';
    previewImage.dataset.state = 'idle';
    previewImage.removeAttribute('src');
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
  if (streamUpdated) {
    streamUpdated.textContent = state.stream.lastUpdate
      ? new Date(state.stream.lastUpdate).toLocaleTimeString()
      : '—';
  }
}

function setConnectionState(status) {
  state.stream.status = status;
  updateStreamWidget();
}

function resetStreamStats() {
  state.stream.heartbeats = 0;
  state.stream.events = 0;
  state.stream.lastUpdate = null;
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
      rebuildChannelsFromEvents();
      renderEvents();
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
  const ts = typeof keyed.ts === 'number' ? keyed.ts : Date.now();
  registerChannel(getEventChannel(keyed), ts);
  renderEvents();
  return keyed;
}

function registerChannel(channel, timestamp = Date.now()) {
  if (!channel) {
    return;
  }

  const stats = state.channelStats.get(channel);
  if (stats) {
    if (timestamp > stats.lastSeen) {
      stats.lastSeen = timestamp;
      updateChannelFilterControls();
    }
    return;
  }

  state.channelStats.set(channel, { firstSeen: timestamp, lastSeen: timestamp });
  updateChannelFilterControls();
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

function updateChannelFilterControls() {
  if (!channelFilterOptions || !channelFilterEmpty) {
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
  const source = new EventSource(`/api/events/stream?${params.toString()}`);
  state.eventSource = source;

  source.onopen = () => {
    setConnectionState('connected');
  };

  source.addEventListener('stream-status', event => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.retryMs) {
        state.reconnectDelayMs = payload.retryMs;
      }
      if (payload?.status) {
        setConnectionState(String(payload.status));
      }
    } catch (error) {
      console.debug('Failed to parse stream-status payload', error);
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

  source.onmessage = event => {
    try {
      const payload = JSON.parse(event.data);
      const keyed = insertEvent(payload);
      recordStreamEvent(typeof payload?.ts === 'number' ? payload.ts : Date.now());
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
    setTimeout(() => {
      setConnectionState('reconnecting');
      subscribe();
    }, state.reconnectDelayMs);
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
}

function resetFilters() {
  state.filters.source = '';
  state.filters.camera = '';
  state.filters.severity = '';
  state.filters.from = '';
  state.filters.to = '';
  state.filters.search = '';
  state.filters.snapshot = '';
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

updateStreamWidget();

loadInitial().then(() => {
  renderEvents();
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
  const channel =
    typeof meta.channel === 'string'
      ? meta.channel
      : typeof meta.camera === 'string'
      ? meta.camera
      : '';
  const camera =
    typeof meta.camera === 'string'
      ? meta.camera
      : state.filters.camera || (typeof event.source === 'string' ? event.source : '');
  return [ts, hash, camera, channel].join(':');
}
