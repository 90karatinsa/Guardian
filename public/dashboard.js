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
const pipelineMetricsContainer = document.getElementById('pipeline-metrics');
const pipelineMetricsEmpty = document.getElementById('pipeline-metrics-empty');
const threatSummaryContainer = document.getElementById('threat-summary');
const threatSummaryEmpty = document.getElementById('threat-summary-empty');
const channelStatusContainer = document.getElementById('channel-status');
const channelStatusEmpty = document.getElementById('channel-status-empty');

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
  channelStats: new Map(),
  metrics: {
    pending: false,
    lastFetched: null,
    data: null
  },
  summary: null,
  digest: null
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

  const meta = event.meta ?? {};
  const snapshotPath = typeof meta.snapshot === 'string' ? meta.snapshot : null;
  const snapshotUrl = typeof meta.snapshotUrl === 'string' ? meta.snapshotUrl : null;
  const faceSnapshotUrl = typeof meta.faceSnapshotUrl === 'string' ? meta.faceSnapshotUrl : null;

  let resolvedUrl = snapshotUrl;
  if (!resolvedUrl && typeof event.id === 'number' && snapshotPath) {
    resolvedUrl = `/api/events/${event.id}/snapshot`;
  } else if (!resolvedUrl && snapshotPath) {
    resolvedUrl = snapshotPath;
  }

  if (!resolvedUrl && faceSnapshotUrl) {
    resolvedUrl = faceSnapshotUrl;
  }

  if (resolvedUrl) {
    const cacheKey = encodeURIComponent(buildSnapshotCacheKey(event));
    const separator = resolvedUrl.includes('?') ? '&' : '?';
    previewImage.src = `${resolvedUrl}${separator}cacheBust=${cacheKey}`;
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
  const ts = typeof keyed.ts === 'number' ? keyed.ts : Date.now();
  registerChannel(getEventChannel(keyed), ts);
  renderEvents();
  updateSummaries();
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

function renderMetricsMessage(message) {
  if (!pipelineMetricsContainer) {
    return;
  }
  pipelineMetricsContainer.innerHTML = '';
  const note = document.createElement('p');
  note.className = 'meta';
  note.textContent = message;
  pipelineMetricsContainer.appendChild(note);
}

function createMetricsRow(label, detail) {
  const item = document.createElement('div');
  item.className = 'metrics-channel';
  const name = document.createElement('span');
  name.textContent = label;
  const text = document.createElement('small');
  text.textContent = detail;
  item.append(name, text);
  return item;
}

function renderThreatSummary(summary) {
  if (!threatSummaryContainer) {
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
        list.appendChild(createMetricsRow(level, `${count} events`));
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
        list.appendChild(createMetricsRow(detector, `${count} events`));
      });
    detectorSection.appendChild(list);
  }
  threatSummaryContainer.appendChild(detectorSection);
}

function renderChannelStatus() {
  if (!channelStatusContainer) {
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
      channelMap.set(channel.id, {
        id: channel.id,
        events: channel.total,
        lastEventTs: channel.lastEventTs,
        severity: channel.bySeverity ?? {},
        snapshots: channel.snapshots ?? 0,
        restarts: 0,
        lastRestartAt: null,
        lastRestartReason: null,
        watchdogBackoffMs: null
      });
    });
  }
  const pipelineChannels = digest?.pipelines?.ffmpeg?.channels ?? [];
  pipelineChannels.forEach(entry => {
    const existing = channelMap.get(entry.channel) ?? {
      id: entry.channel,
      events: 0,
      lastEventTs: null,
      severity: {},
      snapshots: 0,
      restarts: 0,
      lastRestartAt: null,
      lastRestartReason: null,
      watchdogBackoffMs: null
    };
    existing.restarts = entry.restarts ?? 0;
    existing.lastRestartAt = entry.lastRestartAt ?? null;
    existing.lastRestartReason = entry.lastRestart?.reason ?? null;
    existing.watchdogBackoffMs = entry.watchdogBackoffMs ?? null;
    channelMap.set(entry.channel, existing);
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
    const detail = parts.join(' · ');
    list.appendChild(createMetricsRow(entry.id, detail));
  });
  channelStatusContainer.appendChild(list);
}

function renderPipelineSection(label, snapshot) {
  if (!snapshot) {
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
  const section = document.createElement('section');
  section.className = 'metrics-section';
  const heading = document.createElement('h3');
  heading.textContent = 'Retention';
  section.appendChild(heading);

  const summary = document.createElement('div');
  summary.className = 'metrics-summary';
  const totals = retention.totals ?? { archivedSnapshots: 0, prunedArchives: 0, removedEvents: 0 };
  const totalsLine = document.createElement('strong');
  totalsLine.textContent = `${totals.archivedSnapshots} archived · ${totals.prunedArchives} pruned`;
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
  if (!pipelineMetricsContainer) {
    return;
  }
  if (pipelineMetricsEmpty) {
    pipelineMetricsEmpty.remove();
  }

  if (!payload) {
    renderMetricsMessage('Metrics unavailable.');
    return;
  }

  pipelineMetricsContainer.innerHTML = '';

  const updatedAt = document.createElement('p');
  updatedAt.className = 'meta';
  updatedAt.textContent = `Updated ${formatRelativeTime(payload.fetchedAt)}`;
  pipelineMetricsContainer.appendChild(updatedAt);

  const pipelineEntries = [
    ['Video streams', payload.pipelines?.ffmpeg],
    ['Audio streams', payload.pipelines?.audio]
  ];
  pipelineEntries.forEach(([label, snapshot]) => {
    const section = renderPipelineSection(label, snapshot);
    if (section) {
      pipelineMetricsContainer.appendChild(section);
    }
  });

  const retentionSection = renderRetentionSection(payload.retention);
  if (retentionSection) {
    pipelineMetricsContainer.appendChild(retentionSection);
  }

  if (pipelineMetricsContainer.children.length === 1) {
    const empty = document.createElement('p');
    empty.className = 'meta';
    empty.textContent = 'No pipeline metrics available yet.';
    pipelineMetricsContainer.appendChild(empty);
  }
}

async function refreshPipelineMetrics() {
  if (!pipelineMetricsContainer || state.metrics.pending) {
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
    updatePipelineWidget(payload);
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

function computeSummaryFromEvents(events) {
  const totalsByDetector = {};
  const totalsBySeverity = {};
  const channelMap = new Map();

  events.forEach(event => {
    const detector = event.detector ?? 'unknown';
    const severity = event.severity ?? 'info';
    totalsByDetector[detector] = (totalsByDetector[detector] ?? 0) + 1;
    totalsBySeverity[severity] = (totalsBySeverity[severity] ?? 0) + 1;
    const meta = event.meta ?? {};
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

  return {
    totals: {
      byDetector: totalsByDetector,
      bySeverity: totalsBySeverity
    },
    channels: Array.from(channelMap.values())
  };
}

function updateSummaries(serverSummary) {
  if (serverSummary) {
    state.summary = serverSummary;
  } else {
    state.summary = computeSummaryFromEvents(state.events);
  }
  renderThreatSummary(state.summary);
  renderChannelStatus();
}

function setMetricsDigest(digest) {
  state.digest = digest ?? null;
  renderChannelStatus();
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

  source.addEventListener('metrics', event => {
    try {
      const payload = JSON.parse(event.data);
      setMetricsDigest(payload);
    } catch (error) {
      console.debug('Failed to parse metrics payload', error);
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
const METRICS_REFRESH_INTERVAL = 30_000;
refreshPipelineMetrics();
setInterval(() => {
  void refreshPipelineMetrics();
}, METRICS_REFRESH_INTERVAL);

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
