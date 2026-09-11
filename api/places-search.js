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
// WHY TEXT SEARCH INSTEAD OF NEARBY SEARCH
//
// This used to call the "nearbysearch" endpoint. Google's own documentation states
// that Nearby Search (Legacy) "is constrained to strict matches on a subset of
// fields," while Text Search (Legacy) is "optimized for matching ambiguous text
// across a number of fields."
//
// That strictness caused a real, repeatable bug. JOEY DTLA — a downtown Los Angeles
// restaurant with roughly 5,900 reviews — never appeared in a search for restaurants
// in its own zip code. Filtering by type=restaurant missed it because Google's
// category data for that business doesn't carry the plain "restaurant" tag.
// Switching to keyword=restaurant missed it too, because keyword matching leans
// heavily on the business name, and "JOEY DTLA" doesn't contain the word. The
// results that DID come back were dominated by places with "Restaurant" literally
// in their names, and only 19 came back at all for a five-mile radius in one of the
// densest restaurant districts in the country.
//
// Text Search matches the way a person searching would expect: it understands that
// a business is a restaurant without needing the word stamped on its name or type.
// Same single API call per search, same key, same response shape.
// ---------------------------------------------------------------------------

const MAX_RADIUS_METERS = 40234; // 25 miles — matches the app's largest radius option
const DEFAULT_RADIUS_METERS = 8047; // 5 miles

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

  // The search phrase. The frontend sends a keyword for every category now (via the
  // data-keyword attribute on each dropdown option), falling back to the raw type
  // value if one is ever missing. Underscores are swapped for spaces so a fallback
  // like "grocery_or_supermarket" still reads as natural language to Text Search.
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

  // location + radius bias Text Search toward the searched area. Unlike Nearby
  // Search, radius here is a preference rather than a hard boundary, so the frontend
  // also filters results by the distance it computes for each one.
  const params = new URLSearchParams({
    query: searchQuery,
    location: latNum + ',' + lngNum,
    radius: String(radiusNum),
    key: apiKey
  });

  try {
    const googleRes = await fetch('https://maps.googleapis.com/maps/api/place/textsearch/json?' + params.toString());
    const data = await googleRes.json();

    // Short edge cache: identical searches within this window are served from
    // Vercel's cache instead of hitting Google again — cuts cost on repeat and bot
    // traffic without staling results meaningfully.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: 'Could not reach Google Places API.' });
  }
};
