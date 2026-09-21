// Vercel serverless function — proxies the Google Places search so the API key never
// reaches the browser. The frontend calls /api/places-search?... instead of calling
// Google directly; this function attaches the secret key server-side.
//
// FILE LOCATION: in your Vercel project, this file must live at  api/places-search.js
//
// Required setup (do this in the Vercel dashboard, not in this file):
//   Project -> Settings -> Environment Variables -> add GOOGLE_PLACES_API_KEY
// Never paste the real key into this file or into version control.
//
// ---------------------------------------------------------------------------
// WHY THIS PAGINATES
//
// Google's Places search returns a maximum of 20 results per request, plus a
// next_page_token when more exist. This proxy previously read only that first page.
//
// In a dense area that is a severe limitation, because the 20 you get are Google's
// own relevance slice rather than the best-rated places. A real search of zip 90017
// returned businesses with 40, 105, 116 and 150 reviews while omitting JOEY DTLA,
// a restaurant on the same blocks with roughly 5,900 reviews. Nothing was filtering
// JOEY out — it simply sat past the first 20 results and was never requested.
//
// So this now follows next_page_token for up to MAX_PAGES, merges the results, and
// hands the full set to the frontend, which sorts by rating, reviews, distance or
// the Recommended score. Sorting 60 candidates produces a genuinely better top 20
// than sorting whichever 20 Google happened to return first.
//
// COST: each page is a separate billed request. A search in a dense area can now
// cost up to 3x what it did before. Sparse areas are unaffected — when Google
// returns no next_page_token, this stops after one call. Lower MAX_PAGES to 2, or
// to 1, if you want to cap that.
//
// SPEED: Google requires a brief delay before a next_page_token becomes valid, so
// paginating adds roughly two seconds per extra page. If any page fails or times
// out, whatever has been collected so far is returned rather than erroring.
// ---------------------------------------------------------------------------

const MAX_RADIUS_METERS = 40234;   // 25 miles — matches the app's largest radius option
const DEFAULT_RADIUS_METERS = 8047; // 5 miles
const MAX_PAGES = 3;                // Google's hard ceiling is 3 pages (60 results)
const PAGE_TOKEN_DELAY_MS = 1800;   // token needs a moment before Google accepts it

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

module.exports = async function handler(req, res) {
  // Basic CORS: only your own site should be calling this. Once you know your final
  // domain, replace '*' with e.g. 'https://mytoprate.app' below.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ status: 'INVALID_REQUEST', error_message: 'Only GET is supported.' });
    return;
  }

  const { lat, lng, radius, type, keyword } = req.query;

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    res.status(400).json({ status: 'INVALID_REQUEST', error_message: 'lat and lng are required numbers.' });
    return;
  }

  var radiusNum = parseInt(radius, 10);
  if (!Number.isFinite(radiusNum) || radiusNum <= 0) radiusNum = DEFAULT_RADIUS_METERS;
  radiusNum = Math.min(radiusNum, MAX_RADIUS_METERS);

  // The search phrase. The frontend sends a keyword for every category (via the
  // data-keyword attribute on each dropdown option), falling back to the raw type
  // value if one is ever missing. Underscores become spaces so a fallback like
  // "grocery_or_supermarket" still reads as natural language.
  var searchQuery = (keyword || type || '').toString().replace(/_/g, ' ').trim().slice(0, 120);
  if (!searchQuery) {
    res.status(400).json({
      status: 'INVALID_REQUEST',
      error_message: 'A type or keyword is required to search.'
    });
    return;
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      status: 'REQUEST_DENIED',
      error_message: 'Server is missing GOOGLE_PLACES_API_KEY. Set it in the Vercel project\'s environment variables.'
    });
    return;
  }

  const BASE = 'https://maps.googleapis.com/maps/api/place/textsearch/json?';

  // location + radius bias Text Search toward the searched area. radius is a
  // preference here rather than a hard boundary, so the frontend also filters by
  // the distance it computes for each result.
  const firstParams = new URLSearchParams({
    query: searchQuery,
    location: latNum + ',' + lngNum,
    radius: String(radiusNum),
    key: apiKey
  });

  var merged = [];
  var seenPlaceIds = Object.create(null);
  var lastStatus = 'OK';
  var pagesFetched = 0;

  function addResults(list) {
    if (!Array.isArray(list)) return;
    for (var i = 0; i < list.length; i++) {
      var place = list[i];
      var id = place && place.place_id;
      // Guard against the same business appearing on more than one page.
      if (id && seenPlaceIds[id]) continue;
      if (id) seenPlaceIds[id] = true;
      merged.push(place);
    }
  }

  try {
    var url = BASE + firstParams.toString();

    while (pagesFetched < MAX_PAGES) {
      var googleRes = await fetch(url);
      var data = await googleRes.json();
      pagesFetched++;

      lastStatus = (data && data.status) || 'UNKNOWN_ERROR';

      // A hard error on the very first page is worth surfacing to the user.
      // On later pages, keep whatever was already collected instead.
      if (lastStatus !== 'OK' && lastStatus !== 'ZERO_RESULTS') {
        if (pagesFetched === 1) {
          res.status(200).json(data);
          return;
        }
        break;
      }

      addResults(data && data.results);

      var token = data && data.next_page_token;
      if (!token || pagesFetched >= MAX_PAGES) break;

      await sleep(PAGE_TOKEN_DELAY_MS);
      url = BASE + new URLSearchParams({ pagetoken: token, key: apiKey }).toString();
    }

    // Short edge cache: identical searches within this window are served from
    // Vercel's cache instead of hitting Google again — important now that a single
    // search can cost up to three billed requests.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=120');
    res.status(200).json({
      status: merged.length ? 'OK' : 'ZERO_RESULTS',
      results: merged,
      pages_fetched: pagesFetched,
      html_attributions: []
    });
  } catch (err) {
    // If something failed partway through, return what was gathered rather than
    // throwing away a usable set of results.
    if (merged.length) {
      res.status(200).json({ status: 'OK', results: merged, pages_fetched: pagesFetched, html_attributions: [] });
      return;
    }
    res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: 'Could not reach Google Places API.' });
  }
};
