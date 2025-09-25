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

const MAX_EVENTS = 50;

const state = {
  events: [],
  filters: { source: '', camera: '', channel: '', severity: '', from: '', to: '', search: '', snapshot: '' },
  activeId: null,
  eventSource: null,
  reconnectDelayMs: 5000,
  stream: {
    heartbeats: 0,
    events: 0,
    lastUpdate: null,
    status: 'connecting'
  }
};

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

function matchesFilters(event) {
  const meta = event.meta ?? {};
  const channel = typeof meta.channel === 'string' ? meta.channel : '';
  const cameraMeta = typeof meta.camera === 'string' ? meta.camera : '';
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : '';
  const ts = typeof event.ts === 'number' ? event.ts : Date.now();

  if (state.filters.source && event.source !== state.filters.source) {
    return false;
  }
  if (state.filters.camera) {
    const cameraMatches =
      event.source === state.filters.camera ||
      cameraMeta === state.filters.camera ||
      channel === state.filters.camera;
    if (!cameraMatches) {
      return false;
    }
  }
  if (state.filters.channel && channel !== state.filters.channel) {
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
      channel,
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
  renderEvents();
  return keyed;
}

function subscribe() {
  if (state.eventSource) {
    state.eventSource.close();
  }

  resetStreamStats();
  setConnectionState('connecting');

  const params = buildQueryParams();
  params.set('retry', String(state.reconnectDelayMs));
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
  state.filters.channel = (formData.get('channel') ?? '').toString().trim();
  state.filters.severity = (formData.get('severity') ?? '').toString().trim();
  state.filters.search = (formData.get('search') ?? '').toString().trim();
  const snapshot = (formData.get('snapshot') ?? '').toString().trim();
  state.filters.snapshot = snapshot === 'with' || snapshot === 'without' ? snapshot : '';
  state.filters.from = (formData.get('from') ?? '').toString();
  state.filters.to = (formData.get('to') ?? '').toString();
}

function resetFilters() {
  state.filters = {
    source: '',
    camera: '',
    channel: '',
    severity: '',
    from: '',
    to: '',
    search: '',
    snapshot: ''
  };
  filtersForm.reset();
  clearPreview();
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

function buildQueryParams() {
  const params = new URLSearchParams();
  if (state.filters.source) params.set('source', state.filters.source);
  if (state.filters.camera) params.set('camera', state.filters.camera);
  if (state.filters.channel) params.set('channel', state.filters.channel);
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
  const channel = typeof meta.channel === 'string' ? meta.channel : state.filters.channel || '';
  const camera =
    typeof meta.camera === 'string'
      ? meta.camera
      : state.filters.camera || (typeof event.source === 'string' ? event.source : '');
  return [ts, hash, camera, channel].join(':');
}
