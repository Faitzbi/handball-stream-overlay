const HANDBALL_NET_ORIGINS = new Set(['https://www.handball.net', 'https://handball.net']);
const SCHEDULE_PATH_TEAM = /^\/team\/(\d+)\/?$/i;
const CLUB_PATH = /^\/club\/([a-z0-9]+)\/?$/i;
const MATCH_PATH = /^\/match\/(\d+)\/?$/i;

function isHandballNetOrigin(origin) {
  return HANDBALL_NET_ORIGINS.has(origin);
}

function parseTeamScheduleUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const match = u.pathname.match(SCHEDULE_PATH_TEAM);
    if (!match || !isHandballNetOrigin(u.origin)) return null;
    return {
      teamId: match[1],
      seasonId: (u.searchParams.get('season_id') || '').trim() || null,
      origin: u.origin,
    };
  } catch {
    return null;
  }
}

function parseClubUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const match = u.pathname.match(CLUB_PATH);
    if (!match || !isHandballNetOrigin(u.origin)) return null;
    return {
      clubId: match[1],
      seasonId: (u.searchParams.get('season_id') || '').trim() || null,
      origin: u.origin,
    };
  } catch {
    return null;
  }
}

function parseClubId(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^[a-z0-9]+$/i.test(raw) && !raw.includes('/')) return raw;
  const parsed = parseClubUrl(raw);
  return parsed ? parsed.clubId : null;
}

function parseMatchTickerUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    const match = u.pathname.match(MATCH_PATH);
    if (!match || !isHandballNetOrigin(u.origin)) return null;
    return { matchId: match[1], origin: u.origin };
  } catch {
    return null;
  }
}

function isValidScheduleUrl(url) {
  return !!parseTeamScheduleUrl(url);
}

function teamScheduleUrl(teamId, { origin = 'https://handball.net', seasonId = null } = {}) {
  const base = `${origin}/team/${encodeURIComponent(teamId)}`;
  return seasonId ? `${base}?season_id=${encodeURIComponent(seasonId)}` : base;
}

function matchTickerUrl(matchId, { origin = 'https://handball.net' } = {}) {
  return `${origin}/match/${encodeURIComponent(matchId)}`;
}

module.exports = {
  HANDBALL_NET_ORIGINS,
  isHandballNetOrigin,
  parseTeamScheduleUrl,
  parseClubUrl,
  parseClubId,
  parseMatchTickerUrl,
  isValidScheduleUrl,
  teamScheduleUrl,
  matchTickerUrl,
};
