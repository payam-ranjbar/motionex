// sfx.freesound-search: the Freesound provider of the sfx.search contract. One Freesound text search, returned in
// the contract's shape; with fewer_words, a search that finds nothing is repeated with the last word dropped each
// time. The API key comes from the freesound_api_key secret file and is never logged or returned.
import { ToolError } from '../../src/lib/errors.mjs';
import { createClient, licenseCode, searchFilter } from '../../src/lib/freesound.mjs';

const FIELDS = 'id,name,duration,license,username,url,tags,previews,num_downloads,avg_rating';

/** The words of a query, in order. A "quoted phrase" counts as one word, so a shorter query never splits it. */
const wordsOf = (query) => query.match(/"[^"]*"|\S+/g) ?? [];

/**
 * @param {{query: string, limit: number, min_seconds?: number, max_seconds?: number, licenses?: string[],
 *   filter?: string, sort?: string, page?: number, fewer_words: boolean}} input
 * @param {import('../../src/runner/types.mjs').Ctx} ctx
 */
export default async function run(input, ctx) {
  const apiKey = await ctx.secret('freesound_api_key');
  if (!apiKey) throw new ToolError('provider-error', 'no Freesound key (secret file freesound_api_key)');
  if (input.min_seconds !== undefined && input.max_seconds !== undefined && input.min_seconds > input.max_seconds)
    throw new ToolError('invalid-input', 'min_seconds is larger than max_seconds');

  const backoffMs = Number(process.env.MX_FREESOUND_BACKOFF_MS) || 1500;
  const client = createClient({ apiKey, baseUrl: ctx.config.freesoundUrl, backoffMs });
  const filter = searchFilter({ ...input, extra: input.filter });
  /** One search; only the query differs between the first search and a retry. */
  const search = (query) => {
    ctx.progress(null, `searching Freesound for "${query}"`);
    return client.search(
      { query, filter, sort: input.sort, page_size: input.limit, page: input.page, fields: FIELDS },
      { signal: ctx.signal },
    );
  };

  let json = await search(input.query);
  let queryUsed = input.query;
  const words = wordsOf(input.query);
  const tried = [];
  // fewer_words: drop the last word each time, down to the first word alone. At most (words - 1) more requests.
  if (input.fewer_words) {
    for (let n = words.length - 1; n >= 1 && !json.results?.length; n--) {
      const shorter = words.slice(0, n).join(' ');
      tried.push(shorter);
      json = await search(shorter);
      if (json.results?.length) queryUsed = shorter;
    }
  }

  const warnings = [];
  const sounds = (json.results ?? []).map((s) => {
    const out = {
      id: String(s.id),
      name: String(s.name ?? ''),
      seconds: Number(s.duration) || 0,
      license: licenseCode(s.license),
      author: String(s.username ?? ''),
      url: String(s.url ?? `https://freesound.org/s/${s.id}/`),
    };
    if (s.license) out.license_url = String(s.license);
    if (Array.isArray(s.tags)) out.tags = s.tags.map(String);
    const preview = s.previews?.['preview-hq-mp3'];
    if (preview) out.preview = String(preview);
    if (Number.isFinite(s.num_downloads)) out.downloads = s.num_downloads;
    if (Number.isFinite(s.avg_rating)) out.rating = s.avg_rating;
    return out;
  });

  const nothing = `no sounds match "${input.query}"${filter ? ` with filter ${filter}` : ''}`;
  if (queryUsed !== input.query)
    warnings.push(`${nothing}; these sounds are for the shorter query "${queryUsed}" (fewer_words)`);
  else if (!sounds.length) {
    if (tried.length) warnings.push(`${nothing}, nor any shorter query down to "${tried.at(-1)}" (fewer_words)`);
    else if (words.length > 1)
      warnings.push(
        `${nothing}. Freesound matches every word of a query, so fewer words may find sounds: shorten the query, or set fewer_words to true to search again with the last word dropped each time`,
      );
    else warnings.push(nothing);
  }

  return { result: { sounds, total: Number(json.count) || sounds.length, query_used: queryUsed, warnings } };
}
