// Vercel serverless function — proxies Google Places "Nearby Search" so the API key
// never reaches the browser. The frontend calls /api/places-search?... instead of
// calling Google directly; this function attaches the secret key server-side.
//
// FILE LOCATION: in your Vercel project, this file must live at  api/places-search.js
// (create an "api" folder at the project root and put this file inside it).
//
// Required setup (do this in the Vercel dashboard, not in this file):
//   Project -> Settings -> Environment Variables -> add GOOGLE_PLACES_API_KEY
// Never paste the real key into this file or into version control.
//
// Ranking: this uses Google's default "prominence" ranking with an explicit radius.
// An earlier revision tried rankby=distance to fix a bug where a well-known restaurant
// didn't appear in a search from inside that very restaurant. That didn't fix it, and
// distance ranking has its own failure mode: it returns only the 20 *nearest* matches,
// so in a dense downtown a 5,000-review landmark can be crowded out by 20 tiny places
// that happen to sit a few feet closer. Prominence weights ratings and review volume,
// which is what this app is actually for ("best-rated near you"), and the client still
// offers a Nearest sort over whatever comes back. The real cause of that bug was almost
// certainly the strict type= filter, which is why the frontend now searches restaurants
// by keyword instead of by type (see the data-keyword attribute in index.html).

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

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      status: 'REQUEST_DENIED',
      error_message: 'Server is missing GOOGLE_PLACES_API_KEY. Set it in the Vercel project\'s environment variables.'
    });
    return;
  }

  const params = new URLSearchParams({
    location: latNum + ',' + lngNum,
    radius: String(radiusNum),
    key: apiKey
  });
  // keyword and type are mutually exclusive in this app's design — keyword (free text /
  // category-quirk workarounds like "Furniture Stores") takes priority when present.
  if (keyword) {
    params.set('keyword', String(keyword).slice(0, 100));
  } else if (type) {
    params.set('type', String(type).slice(0, 60));
  }

  try {
    const googleRes = await fetch('https://maps.googleapis.com/maps/api/place/nearbysearch/json?' + params.toString());
    const data = await googleRes.json();

    // Short edge cache: identical searches (same location/type/keyword) within this
    // window are served from Vercel's cache instead of hitting Google again — cuts
    // cost on repeat/bot traffic without staling results meaningfully.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ status: 'UNKNOWN_ERROR', error_message: 'Could not reach Google Places API.' });
  }
};
