const fetch = require('node-fetch');
const cheerio = require('cheerio');

const CLIENT_TOKEN_TTL_MS = 8 * 60 * 1000;
let cachedClientToken = { origin: '', token: '', fetchedAt: 0 };

function handballBrowserHeaders(origin, accept) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: accept,
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    Referer: `${origin}/`,
    'Cache-Control': 'no-cache',
  };
}

function extractClientToken(html) {
  const $ = cheerio.load(html);
  return ($('meta[name="client-token"]').attr('content') || '').trim() || null;
}

async function getHandballClientToken(origin) {
  const now = Date.now();
  if (
    cachedClientToken.token
    && cachedClientToken.origin === origin
    && (now - cachedClientToken.fetchedAt) < CLIENT_TOKEN_TTL_MS
  ) {
    return cachedClientToken.token;
  }
  const pageRes = await fetch(`${origin}/`, {
    headers: handballBrowserHeaders(origin, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'),
    cache: 'no-store',
  });
  if (!pageRes.ok) {
    const err = new Error(`handball.net Token-Seite nicht erreichbar (HTTP ${pageRes.status}).`);
    err.status = 502;
    throw err;
  }
  const token = extractClientToken(await pageRes.text());
  if (!token) {
    const err = new Error('handball.net Client-Token konnte nicht gelesen werden.');
    err.status = 502;
    throw err;
  }
  cachedClientToken = { origin, token, fetchedAt: now };
  return token;
}

async function handballApiGet(origin, pathAndQuery, token) {
  const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${origin}${pathAndQuery}`;
  const headers = {
    ...handballBrowserHeaders(origin, 'application/json'),
    'x-client-token': token,
  };
  let res = await fetch(url, { headers, cache: 'no-store' });
  if (res.status === 403) {
    cachedClientToken = { origin: '', token: '', fetchedAt: 0 };
    const fresh = await getHandballClientToken(origin);
    headers['x-client-token'] = fresh;
    res = await fetch(url, { headers, cache: 'no-store' });
  }
  return res;
}

function clearClientTokenCache() {
  cachedClientToken = { origin: '', token: '', fetchedAt: 0 };
}

module.exports = {
  getHandballClientToken,
  handballApiGet,
  clearClientTokenCache,
  handballBrowserHeaders,
};
