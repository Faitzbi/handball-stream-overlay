const { getHandballClientToken, handballApiGet } = require('./client');
const { parseTeamScheduleUrl, matchTickerUrl, parseClubId } = require('./urls');

const DEFAULT_ORIGIN = 'https://www.handball.net';
const AGE_ORDER = {
  ERWACHSENE: 0,
  'A-JUGEND': 1,
  'B-JUGEND': 2,
  'C-JUGEND': 3,
  'D-JUGEND': 4,
  'E-JUGEND': 5,
  'F-JUGEND': 6,
  MINIS: 7,
};

function formatMatchDateTime(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Europe/Berlin',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

async function resolveSeasonRange(origin, seasonId, clientToken) {
  let dateFrom = '2026-07-01';
  let dateTo = '2027-06-30';
  let resolvedSeasonId = seasonId || null;
  try {
    const seasonsRes = await handballApiGet(origin, '/api/new/seasons', clientToken);
    if (seasonsRes.ok) {
      const seasonsJson = await seasonsRes.json();
      const seasons = Array.isArray(seasonsJson?.data) ? seasonsJson.data : [];
      const season = (seasonId && seasons.find((s) => String(s.id) === String(seasonId)))
        || seasons.find((s) => s.is_active)
        || seasons[0];
      if (season?.id != null) resolvedSeasonId = String(season.id);
      if (season?.start_date) dateFrom = String(season.start_date).slice(0, 10);
      if (season?.end_date) dateTo = String(season.end_date).slice(0, 10);
    }
  } catch (err) {
    console.warn('[schedule] seasons lookup failed, using default range:', err.message);
  }
  return { dateFrom, dateTo, seasonId: resolvedSeasonId };
}

function mapApiMatchToUpcoming(match, origin) {
  const gameId = String(match.id);
  const home = (match.local && match.local.name) || 'Heim';
  const away = (match.visitor && match.visitor.name) || 'Gast';
  const phaseName = match.phase?.name || match.phase?.competition?.name || '';
  const competitionName = match.phase?.competition?.name || '';
  return {
    gameId,
    label: `${home} vs ${away}`,
    dateTime: formatMatchDateTime(match.date),
    tickerUrl: matchTickerUrl(gameId, { origin }),
    phaseName,
    competitionName,
    homeTeamId: match.local?.id != null ? String(match.local.id) : null,
    awayTeamId: match.visitor?.id != null ? String(match.visitor.id) : null,
  };
}

async function fetchUpcomingForTeamId(teamId, {
  origin = DEFAULT_ORIGIN,
  seasonId = null,
  limit = 10,
} = {}) {
  if (!teamId) {
    const err = new Error('Keine Team-ID angegeben.');
    err.status = 400;
    throw err;
  }
  const clientToken = await getHandballClientToken(origin);
  const range = await resolveSeasonRange(origin, seasonId, clientToken);
  const matchesUrl = `/api/new/matches?team_id=${encodeURIComponent(teamId)}&date_from=${encodeURIComponent(range.dateFrom)}&date_to=${encodeURIComponent(range.dateTo)}&per_page=100`;
  const matchesRes = await handballApiGet(origin, matchesUrl, clientToken);
  if (!matchesRes.ok) {
    const err = new Error(`Spielplan-API nicht erreichbar (HTTP ${matchesRes.status}).`);
    err.status = 502;
    throw err;
  }
  const matchesJson = await matchesRes.json();
  const matches = Array.isArray(matchesJson?.data) ? matchesJson.data : [];
  const now = Date.now();
  return matches
    .filter((m) => m && !m.status?.is_finished)
    .filter((m) => {
      if (!m.date) return true;
      const t = new Date(m.date).getTime();
      return Number.isNaN(t) || t >= now - 6 * 60 * 60 * 1000;
    })
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .slice(0, limit)
    .map((m) => mapApiMatchToUpcoming(m, origin));
}

async function fetchUpcomingFromTeamApi(scheduleUrl, { limit = 10 } = {}) {
  const parsed = parseTeamScheduleUrl(scheduleUrl);
  if (!parsed) {
    const err = new Error('Ungültige Team-Spielplan-URL.');
    err.status = 400;
    throw err;
  }
  return fetchUpcomingForTeamId(parsed.teamId, {
    origin: parsed.origin,
    seasonId: parsed.seasonId,
    limit,
  });
}

function mapClubTeam(team) {
  const ageCategory = team.age_category?.name || team.age_category || '';
  const gender = team.gender?.name || team.gender?.id || team.gender || '';
  const genderLabel = gender === 'Male' || gender === 'M' ? 'Männer'
    : gender === 'Female' || gender === 'F' ? 'Frauen'
      : gender === 'Mixed' ? 'Mixed'
        : String(gender || '');
  const parts = [team.name, genderLabel, ageCategory].filter(Boolean);
  return {
    id: String(team.id),
    name: team.name || `Team ${team.id}`,
    gender: genderLabel || String(gender || ''),
    ageCategory: String(ageCategory || ''),
    discipline: team.discipline?.name || team.discipline || '',
    label: parts.join(' · '),
    clubId: team.club?.id != null ? String(team.club.id) : null,
  };
}

async function fetchClubTeams(clubIdOrUrl, { origin = DEFAULT_ORIGIN, seasonId = null } = {}) {
  const clubId = parseClubId(clubIdOrUrl);
  if (!clubId) {
    const err = new Error('Ungültige Club-ID oder Club-URL.');
    err.status = 400;
    throw err;
  }
  const clientToken = await getHandballClientToken(origin);
  const range = await resolveSeasonRange(origin, seasonId, clientToken);
  let path = `/api/new/teams?club_id=${encodeURIComponent(clubId)}`;
  if (range.seasonId) path += `&season_id=${encodeURIComponent(range.seasonId)}`;
  const res = await handballApiGet(origin, path, clientToken);
  if (!res.ok) {
    const err = new Error(`Teams-API nicht erreichbar (HTTP ${res.status}).`);
    err.status = 502;
    throw err;
  }
  const json = await res.json();
  const teams = Array.isArray(json?.data) ? json.data.map(mapClubTeam) : [];
  teams.sort((a, b) => {
    const ao = AGE_ORDER[a.ageCategory] ?? 50;
    const bo = AGE_ORDER[b.ageCategory] ?? 50;
    if (ao !== bo) return ao - bo;
    if (a.gender !== b.gender) return a.gender.localeCompare(b.gender, 'de');
    return a.name.localeCompare(b.name, 'de');
  });
  return {
    clubId,
    seasonId: range.seasonId,
    teams,
  };
}

module.exports = {
  formatMatchDateTime,
  fetchUpcomingFromTeamApi,
  fetchUpcomingForTeamId,
  fetchClubTeams,
  mapApiMatchToUpcoming,
  DEFAULT_ORIGIN,
};
