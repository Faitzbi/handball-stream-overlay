const { getHandballClientToken, handballApiGet } = require('./client');
const { parseMatchTickerUrl } = require('./urls');
const {
  selectNewestEvent,
  isHalbzeitpauseBlock,
  toOverlayEventType,
  mapNewApiEventToOverlayType,
  formatNewApiPlayerName,
  buildNewApiEventText,
  eventIndicatesGameStartOrResume,
  eventsIndicateLivePlay,
  scoreFromEvents,
} = require('./events');

function normalizeLogoUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (raw.startsWith('handball-net:')) {
    return `https://www.handball.net/${raw.split(':').slice(1).join(':').replace(/^\/?/, '')}`;
  }
  if (raw.startsWith('/')) return `https://handball.net${raw}`;
  return raw;
}

function newestTimestamp(events) {
  if (!events || !events.length) return 0;
  return Math.max(...events.map((e) => new Date(e.timestamp || 0).getTime()).filter((n) => !Number.isNaN(n)), 0);
}

function resolveOurSide(homeTeamId, awayTeamId, ourTeamId) {
  if (ourTeamId == null || ourTeamId === '') return null;
  const our = String(ourTeamId);
  if (homeTeamId != null && String(homeTeamId) === our) return 'home';
  if (awayTeamId != null && String(awayTeamId) === our) return 'away';
  return null;
}

async function fetchMatchDataBundle(tickerUrl, { includeLineups = false } = {}) {
  const parsed = parseMatchTickerUrl(tickerUrl);
  if (!parsed) {
    const err = new Error('Ungültige Match-URL. Erwartet: https://handball.net/match/{id}');
    err.status = 400;
    throw err;
  }
  const { origin, matchId } = parsed;
  const token = await getHandballClientToken(origin);
  const [matchRes, eventsRes, lineupsRes] = await Promise.all([
    handballApiGet(origin, `/api/new/matches?match_id=${encodeURIComponent(matchId)}`, token),
    handballApiGet(origin, `/api/new/matches/${encodeURIComponent(matchId)}/events`, token),
    includeLineups
      ? handballApiGet(origin, `/api/new/matches/${encodeURIComponent(matchId)}/lineups`, token)
      : Promise.resolve(null),
  ]);

  if (!matchRes.ok) {
    const err = new Error(`Match-API nicht erreichbar (HTTP ${matchRes.status}).`);
    err.status = 502;
    throw err;
  }

  const matchJson = await matchRes.json();
  const match = Array.isArray(matchJson?.data) ? matchJson.data[0] : matchJson?.data;
  if (!match) {
    const err = new Error('Match nicht gefunden.');
    err.status = 404;
    throw err;
  }

  let events = [];
  let eventsError = null;
  if (!eventsRes.ok) {
    eventsError = `Events-API HTTP ${eventsRes.status}`;
    console.warn('[match] Events soft-fail:', eventsError);
  } else {
    try {
      const eventsJson = await eventsRes.json();
      events = Array.isArray(eventsJson?.data) ? eventsJson.data : [];
    } catch (err) {
      eventsError = err.message;
      console.warn('[match] Events JSON parse failed:', eventsError);
    }
  }

  let lineups = null;
  if (lineupsRes && lineupsRes.ok) {
    try {
      const lineupsJson = await lineupsRes.json();
      lineups = lineupsJson?.data || null;
    } catch (_) { /* ignore */ }
  }

  return { origin, matchId, match, events, lineups, eventsError };
}

function parseNewMatchApi(match, events, { ourTeamId = null } = {}) {
  const homeTeam = match.local?.name || 'Heim';
  const awayTeam = match.visitor?.name || 'Gast';
  const homeTeamId = match.local?.id != null ? String(match.local.id) : null;
  const awayTeamId = match.visitor?.id != null ? String(match.visitor.id) : null;
  const homeLogoUrl = normalizeLogoUrl(match.local?.club?.logo || '');
  const awayLogoUrl = normalizeLogoUrl(match.visitor?.club?.logo || '');
  const newestEvent = selectNewestEvent(events.slice());
  const status = match.status || {};
  const block = String(newestEvent?.block || '').trim();
  const liveFromEvents = eventsIndicateLivePlay(events);
  const eventScore = scoreFromEvents(events);

  let homeGoals = typeof match.result?.local === 'number' ? match.result.local : 0;
  let awayGoals = typeof match.result?.visitor === 'number' ? match.result.visitor : 0;
  // Event-Scores auch ohne is_live/is_finished (Oberliga-Status oft verzögert)
  if (eventScore) {
    homeGoals = eventScore.local;
    awayGoals = eventScore.visitor;
  } else if ((status.is_live || status.is_finished) && newestEvent?.score) {
    if (typeof newestEvent.score.local === 'number') homeGoals = newestEvent.score.local;
    if (typeof newestEvent.score.visitor === 'number') awayGoals = newestEvent.score.visitor;
  }

  let period = block || '';
  let gameStatus = 'Vorbereitung';
  if (status.is_finished) {
    gameStatus = 'Beendet';
    period = period || 'Spiel beendet';
  } else if (status.is_live || liveFromEvents) {
    if (isHalbzeitpauseBlock(block)) {
      gameStatus = 'Pause';
      period = block || 'Halbzeitpause';
    } else {
      gameStatus = 'Live';
      period = period || 'Jetzt Live!';
    }
  } else {
    gameStatus = 'Vorbereitung';
    period = period || 'Vorbereitung';
  }

  let lastEvent = '';
  let lastScorer = '';
  let lastEventType = '';
  let lastEventPhotoUrl = '';
  let overlayType = '';
  if (newestEvent) {
    overlayType = mapNewApiEventToOverlayType(newestEvent);
    lastEvent = buildNewApiEventText(newestEvent, homeTeam, awayTeam);
    lastEventType = toOverlayEventType(overlayType);
    if (overlayType === 'Goal' || overlayType === 'SevenMeterGoal') {
      lastScorer = formatNewApiPlayerName(newestEvent.player);
    }
    lastEventPhotoUrl = (newestEvent.player && newestEvent.player.photo_url) || '';
  } else if (!status.is_live && !status.is_finished && !liveFromEvents) {
    lastEvent = '00:00 - Spiel noch nicht gestartet';
  }

  const ourSide = resolveOurSide(homeTeamId, awayTeamId, ourTeamId);
  const lastEventTeamId = newestEvent?.team?.id != null ? String(newestEvent.team.id) : null;
  const lastEventIsHome = newestEvent?.is_home === true
    ? true
    : newestEvent?.is_home === false
      ? false
      : null;

  return {
    homeTeam,
    awayTeam,
    homeTeamId,
    awayTeamId,
    ourSide,
    ourTeamId: ourTeamId != null && ourTeamId !== '' ? String(ourTeamId) : null,
    lastEventTeamId,
    lastEventIsHome,
    homeGoals,
    awayGoals,
    period,
    gameStatus,
    lastEvent,
    lastScorer,
    lastEventType,
    lastEventPhotoUrl,
    homeLogoUrl,
    awayLogoUrl,
    newestEvent,
    overlayType,
    block,
    eventsCount: events.length,
    liveFromEvents,
  };
}

function mapNewLineupPlayers(side, events) {
  const players = Array.isArray(side?.players) ? side.players : [];
  const teamId = side?.team?.id;
  const statsByPlayerId = {};
  for (const ev of events || []) {
    const pid = ev.player?.id;
    if (!pid) continue;
    if (teamId != null && ev.team?.id != null && String(ev.team.id) !== String(teamId)) continue;
    if (!statsByPlayerId[pid]) {
      statsByPlayerId[pid] = { goals: 0, yellowCards: 0, timePenalties: 0, redCards: 0, blueCards: 0 };
    }
    const t = mapNewApiEventToOverlayType(ev);
    if (t === 'Goal' || t === 'SevenMeterGoal') statsByPlayerId[pid].goals += 1;
    if (t === 'Warning') statsByPlayerId[pid].yellowCards += 1;
    if (t === 'TwoMinutePenalty') statsByPlayerId[pid].timePenalties += 1;
    if (t === 'Disqualification') statsByPlayerId[pid].redCards += 1;
    if (t === 'BlueCard') statsByPlayerId[pid].blueCards += 1;
  }
  return players.map((row) => {
    const p = row.player || {};
    const id = p.id;
    const st = statsByPlayerId[id] || { goals: 0, yellowCards: 0, timePenalties: 0, redCards: 0, blueCards: 0 };
    return {
      number: row.number != null ? row.number : '',
      name: formatNewApiPlayerName(p) || '–',
      goals: st.goals,
      yellowCards: st.yellowCards,
      timePenalties: st.timePenalties,
      redCards: st.redCards,
      blueCards: st.blueCards,
      firstname: p.first_name || '',
      lastname: p.last_name || '',
      penaltyGoals: 0,
    };
  });
}

function buildTimeoutPopupFromNewApi(parsed, events, lineups, newestEvent) {
  const homePlayers = mapNewLineupPlayers(lineups?.local, events);
  const awayPlayers = mapNewLineupPlayers(lineups?.visitor, events);
  const top3 = (arr) => arr
    .slice()
    .sort((a, b) => (b.goals || 0) - (a.goals || 0))
    .slice(0, 3)
    .map((p) => ({ name: p.name || '–', goals: p.goals || 0, number: p.number != null ? p.number : '' }));
  const isAway = newestEvent?.is_home === false;
  const sortedEvents = events.slice().sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return tb - ta;
  });
  return {
    team: isAway ? 'Away' : 'Home',
    teamLogoUrl: (isAway ? parsed.awayLogoUrl : parsed.homeLogoUrl) || '',
    homeLogoUrl: parsed.homeLogoUrl || '',
    awayLogoUrl: parsed.awayLogoUrl || '',
    last5Events: sortedEvents.slice(0, 5).map((e) => ({
      time: String(e.minute || '').trim(),
      message: buildNewApiEventText(e, parsed.homeTeam, parsed.awayTeam).replace(/^\d{1,2}:\d{2}\s*-\s*/, ''),
    })),
    top3Home: top3(homePlayers),
    top3Away: top3(awayPlayers),
  };
}

function buildHalftimePopupFromNewApi(parsed, events, lineups, title) {
  const homePlayers = mapNewLineupPlayers(lineups?.local, events);
  const awayPlayers = mapNewLineupPlayers(lineups?.visitor, events);
  const sortByNumber = (arr) => arr.slice().sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  return {
    title: title || 'Halbzeit',
    homeTeam: parsed.homeTeam || '',
    awayTeam: parsed.awayTeam || '',
    homeLogoUrl: parsed.homeLogoUrl || '',
    awayLogoUrl: parsed.awayLogoUrl || '',
    homePlayers: sortByNumber(homePlayers),
    awayPlayers: sortByNumber(awayPlayers),
    isTest: false,
  };
}

module.exports = {
  normalizeLogoUrl,
  newestTimestamp,
  fetchMatchDataBundle,
  parseNewMatchApi,
  mapNewLineupPlayers,
  buildTimeoutPopupFromNewApi,
  buildHalftimePopupFromNewApi,
  resolveOurSide,
  eventIndicatesGameStartOrResume,
  isHalbzeitpauseBlock,
};
