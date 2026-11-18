// sfx.freesound-search: the Freesound provider of the sfx.search contract. One Freesound text search, returned in
// the contract's shape. The API key comes from the freesound_api_key secret file and is never logged or returned.
import { ToolError } from '../../src/lib/errors.mjs';
import { createClient, licenseCode, searchFilter } from '../../src/lib/freesound.mjs';

const FIELDS = 'id,name,duration,license,username,url,tags,previews,num_downloads,avg_rating';

/**
 * @param {{query: string, limit: number, min_seconds?: number, max_seconds?: number, licenses?: string[],
 *   filter?: string, sort?: string, page?: number}} input
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
  ctx.progress(null, `searching Freesound for "${input.query}"`);
  const json = await client.search(
    {
      query: input.query,
      filter,
      sort: input.sort,
      page_size: input.limit,
      page: input.page,
      fields: FIELDS,
    },
    { signal: ctx.signal },
  );

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
  if (!sounds.length) warnings.push(`no sounds match "${input.query}"${filter ? ` with filter ${filter}` : ''}`);
  return { result: { sounds, total: Number(json.count) || sounds.length, warnings } };
}
