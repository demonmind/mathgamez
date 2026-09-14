const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

// Server-side only - the family's API key never reaches the browser.
// safeSearch=strict is a best-effort content filter, not a guarantee;
// this is documented to parents in the dashboard UI, not just here.
async function searchYoutubeVideos(apiKey, query) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('safeSearch', 'strict');
  url.searchParams.set('maxResults', '10');
  url.searchParams.set('q', query);
  url.searchParams.set('key', apiKey);

  // Deliberately not a 5xx status: Cloudflare (and similar proxies) swaps
  // in their own generic error page for 5xx responses, discarding our
  // actual JSON body - a 422 passes through untouched and is semantically
  // fair anyway (the request was fine, the family's own key/quota is the
  // problem, not our server).
  let response;
  try {
    response = await fetch(url.toString());
  } catch (err) {
    const error = new Error('Could not reach YouTube right now');
    error.status = 422;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      response.status === 403
        ? 'That YouTube API key was rejected (invalid, or its quota is used up)'
        : 'YouTube search failed, please try again later'
    );
    error.status = 422;
    throw error;
  }

  const data = await response.json();
  return (data.items || [])
    .filter((item) => item.id && item.id.videoId)
    .map((item) => ({
      youtubeVideoId: item.id.videoId,
      title: item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails && item.snippet.thumbnails.medium
        ? item.snippet.thumbnails.medium.url
        : null,
    }));
}

module.exports = { searchYoutubeVideos };
