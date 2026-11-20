const OVERLAY_EVENT_TYPES = new Set([
  'Goal',
  'SevenMeterGoal',
  'Warning',
  'TwoMinutePenalty',
  'Disqualification',
  'BlueCard',
]);

function extractGameTime(timeStr) {
  if (!timeStr) return 0;
  const match = String(timeStr).match(/(\d{1,2}):(\d{2})/);
  if (match) {
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }
  return 0;
}

function selectNewestEvent(events) {
  if (!events || events.length === 0) return null;
  const sortedEvents = events.slice().sort((a, b) => {
    const timeA = new Date(a.timestamp || a.time || 0).getTime();
    const timeB = new Date(b.timestamp || b.time || 0).getTime();
    if (timeA !== timeB) return timeB - timeA;

    const idA = Number(a.id || a.eventId || 0);
    const idB = Number(b.id || b.eventId || 0);
    if (idA !== idB) return idB - idA;

    const gameTimeA = extractGameTime(a.minute || a.gameTime || a.time || '');
    const gameTimeB = extractGameTime(b.minute || b.gameTime || b.time || '');
    return gameTimeB - gameTimeA;
  });
  return sortedEvents[0];
}

function isHalbzeitpauseBlock(block) {
  return /halbzeitpause/i.test(String(block || '').trim());
}

function dedupeEventText(text) {
  if (!text) return '';
  let t = String(text).trim().replace(/\s+/g, ' ');
  t = t.replace(/((?:\d{1,2}:\d{2})\s*-\s*[^-]+?)(?:\s+\1)+/gi, '$1');
  t = t.replace(/(Tor durch [^(]+\([^)]*\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(7-Meter\s+Tor durch [^(]+\([^)]*\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(7-Meter verworfen \([^)]+\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(2 Minuten für [^(]+\([^)]+\))(?:\s+\1)+/gi, '$1');
  t = t.replace(/(Timeout\s+[^-]+)(?:\s+\1)+/gi, '$1');
  return t;
}

function toOverlayEventType(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const t = raw.trim();
  return OVERLAY_EVENT_TYPES.has(t) ? t : '';
}

function mapNewApiEventToOverlayType(ev) {
  if (!ev) return '';
  const et = ev.event_type || {};
  const id = Number(et.id);
  const name = String(et.name || ev.type || ev.eventType || '').trim().toLowerCase();
  if (id === 15 || name === 'tor' || (et.is_goal && !/siebenmeter|7[- ]?meter|7m/.test(name))) return 'Goal';
  if (id === 39 || /siebenmeter\s*tor|7[- ]?meter\s*tor|7m[- ]?tor/.test(name)) return 'SevenMeterGoal';
  if (id === 2 || /verwarnung|gelb/.test(name)) return 'Warning';
  if (id === 13 || /zwei\s*minuten|2[- ]?min/.test(name)) return 'TwoMinutePenalty';
  if (id === 30 || /auszeit|timeout/.test(name)) return 'Timeout';
  if (id === 8 || /disqualif|rote\s*karte|red\s*card/.test(name)) return 'Disqualification';
  if (/blau|blue\s*card/.test(name)) return 'BlueCard';
  if (et.is_goal) return /siebenmeter|7[- ]?meter|7m/.test(name) ? 'SevenMeterGoal' : 'Goal';
  return '';
}

function formatNewApiPlayerName(player) {
  if (!player) return '';
  if (typeof player === 'string') return player.trim();
  return [player.first_name, player.last_name].filter(Boolean).join(' ').trim();
}

function buildNewApiEventText(ev, homeTeam, awayTeam) {
  const minute = String(ev.minute || ev.gameTime || ev.time || '').trim();
  const typeName = String(ev.event_type?.name || '').trim() || 'Ereignis';
  const player = formatNewApiPlayerName(ev.player);
  const team = (ev.team && ev.team.name)
    || (ev.is_home === true ? homeTeam : ev.is_home === false ? awayTeam : '')
    || '';
  let body = typeName;
  if (player && team) body = `${typeName} ${player} (${team})`;
  else if (player) body = `${typeName} ${player}`;
  else if (team) body = `${typeName} (${team})`;
  return dedupeEventText(minute ? `${minute} - ${body}` : body);
}

/** Live-Signal: Anpfiff, Tore, Strafen, Auszeit, Halbzeit-Blöcke – auch ohne ev.message. */
function eventIndicatesGameStartOrResume(ev) {
  if (!ev) return false;
  const overlayType = mapNewApiEventToOverlayType(ev);
  if (overlayType === 'Timeout') return true;
  if (overlayType === 'Goal' || overlayType === 'SevenMeterGoal') return true;
  if (overlayType === 'TwoMinutePenalty' || overlayType === 'Warning' || overlayType === 'Disqualification' || overlayType === 'BlueCard') {
    return true;
  }

  const typeId = Number(ev.event_type?.id || 0);
  // Anpfiff / Abpfiff / Halbzeit (handball.net new API)
  if (typeId === 10000 || typeId === 10001 || typeId === 10002) return true;

  const typeName = (ev.event_type?.name || ev.type || ev.eventType || '').toString().trim().toLowerCase();
  const msg = (ev.message || '').trim().toLowerCase();
  const block = (ev.block || '').toString().trim().toLowerCase();
  const haystack = `${typeName} ${msg}`;

  if (typeName === 'startperiod' || typeName === 'resume' || typeName === 'startseite teil') return true;
  if (/1\.\s*halbzeit|2\.\s*halbzeit/.test(block) && (/start|anpfiff|tor|zwei|auszeit|siebenmeter/.test(typeName) || overlayType)) {
    return true;
  }
  if (/anpfiff|abpfiff|halbzeit|spiel\s+gestartet|spielbeginn|spiel\s+läuft\s+weiter|auszeit\s+beendet|halbzeit\s+beendet|zweite\s+halbzeit/.test(haystack)) {
    return true;
  }
  if (typeof ev.global_minute === 'number' && ev.global_minute > 0) return true;
  if (/1\.\s*halbzeit|2\.\s*halbzeit/.test(block) && typeId > 0 && typeId !== 40 && typeId !== 41 && typeId !== 42 && typeId !== 43) {
    // Aufstellungs-Events (40–43) allein zählen nicht als Live
    return mapNewApiEventToOverlayType(ev) !== '' || /tor|zwei|auszeit|siebenmeter|anpfiff|abpfiff|disqualif/.test(typeName);
  }
  return false;
}

function eventsIndicateLivePlay(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  return events.some((ev) => eventIndicatesGameStartOrResume(ev));
}

function scoreFromEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const withScore = events
    .filter((ev) => ev && ev.score && (typeof ev.score.local === 'number' || typeof ev.score.visitor === 'number'))
    .slice();
  if (!withScore.length) return null;
  const newest = selectNewestEvent(withScore);
  if (!newest?.score) return null;
  return {
    local: typeof newest.score.local === 'number' ? newest.score.local : 0,
    visitor: typeof newest.score.visitor === 'number' ? newest.score.visitor : 0,
  };
}

module.exports = {
  OVERLAY_EVENT_TYPES,
  extractGameTime,
  selectNewestEvent,
  isHalbzeitpauseBlock,
  dedupeEventText,
  toOverlayEventType,
  mapNewApiEventToOverlayType,
  formatNewApiPlayerName,
  buildNewApiEventText,
  eventIndicatesGameStartOrResume,
  eventsIndicateLivePlay,
  scoreFromEvents,
};
