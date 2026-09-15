/**
 * Where a recipe came from, as the detail screen says it (backlog A6:
 * *"keep the source URL (+ source photo) when importing a recipe"*).
 *
 * Pure string work over the four columns 0031 already ships — `source_url`,
 * `source_platform`, `source_author`, `source_image_url`. No DB, no network:
 * the URL is only ever DISPLAYED and handed to `Linking`, and the thumbnail URL
 * is only ever handed to an `<Image>`. Exactly the shape of
 * src/lib/knowledge/provenance.ts, and for the same reason — a provenance line
 * that two screens describe differently is worse than none.
 *
 * ## The 0031 condition, and how it is resolved
 *
 * `source_image_url`'s own column comment reads: *"Stored at import; NOT
 * rendered until the Phase 4 media decision sanctions the fetch"*, and
 * docs/recipes-grocery.md §5 spells out what that guarded against — **"no quiet
 * network image fetches"**. The recipe-import ADR (same doc, §Network) admits
 * one new network surface and closes it with *"never media downloads"*.
 *
 * The owner's A6 ask IS that decision arriving, and it is resolved NARROWLY,
 * so the sentence that was written to be protected stays true:
 *
 *   - **Nothing is downloaded.** The URL is handed to the OS image loader for
 *     display on a screen the user opened. No copy is written to disk, no
 *     prefetch, no background load, and no `File`/`fetch` call — which is what
 *     "media download" meant. `app/recipe-detail.tsx` is the only renderer; the
 *     book's list rows do not draw it, so opening the recipe book does not fan
 *     out a request per row.
 *   - **It is not quiet.** It is drawn under a source line naming the platform
 *     and author, on a recipe the user themselves imported from a link they
 *     themselves shared.
 *   - **The local photo always wins.** 0034's `photo_file_name` takes
 *     precedence ({@link sourceThumbnailUrl} returns null whenever one exists),
 *     so the moment the owner adds his own photo the remote host is never
 *     contacted for this recipe again.
 *   - **https only.** iOS ATS blocks cleartext anyway; requiring it here means
 *     a stored `http://` thumbnail draws nothing rather than an empty frame.
 *
 * The privacy fact, stated rather than buried: rendering a remote thumbnail
 * tells that host's CDN that this device opened this recipe. That is the whole
 * of the cost, it is bounded by the precedence rule above, and it is why the
 * caller must also hide the frame on a load error — a failed remote image must
 * never leave a broken box on a cookbook page.
 */
import type { RecipePlatform, RecipeRow } from './types';

/** The bare host of a URL, for attribution. Null when it isn't one. */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  return m ? m[1]!.toLowerCase().replace(/^www\./, '') : null;
}

/** Only http(s) is ever handed to the OS from a stored provenance string — a
 *  scheme allow-list at the point a stored string becomes an ACTION, not a
 *  formality resting on every past and future writer having been careful. */
export function isOpenableSourceUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/** How each platform writes its own name. `website` has none worth printing —
 *  the host is the specific, useful fact — so it maps to null and the line
 *  falls through to {@link sourceHost}. */
const PLATFORM_NAME: Record<RecipePlatform, string | null> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  website: null,
};

/** What the recipe was imported from, as a `platform · author` sentence. */
type SourceColumns = Pick<
  RecipeRow,
  'source_url' | 'source_platform' | 'source_author' | 'source_image_url'
>;

/**
 * The provenance line — `Instagram · @thefoodjournal`, `seriouseats.com`,
 * `YouTube`. Null when the recipe carries no provenance at all, which is the
 * normal state of one typed by hand: the line is then simply absent rather than
 * printing an empty stand-in.
 *
 * The site's own name is preferred over the word "website" because a host IS
 * the attribution for a recipe blog, and "website · Kenji López-Alt" tells the
 * reader less than "seriouseats.com · Kenji López-Alt" does.
 */
export function recipeSourceLine(recipe: SourceColumns): string | null {
  const platform = recipe.source_platform ? PLATFORM_NAME[recipe.source_platform] : null;
  const parts = [platform ?? sourceHost(recipe.source_url), recipe.source_author].filter(
    (p): p is string => typeof p === 'string' && p.trim() !== ''
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The remote thumbnail to draw, or null — see this module's header for the
 * decision that makes drawing it allowed at all.
 *
 * Null whenever the recipe has its OWN photo (0034): the cook's photograph of
 * the dish he actually made outranks the poster's promotional still, and the
 * precedence is expressed here rather than at the call site so it cannot be
 * forgotten by the next renderer.
 */
export function sourceThumbnailUrl(
  recipe: Pick<SourceColumns, 'source_image_url'>,
  localPhotoUri: string | null
): string | null {
  if (localPhotoUri !== null) return null;
  const url = recipe.source_image_url?.trim();
  return url && /^https:\/\//i.test(url) ? url : null;
}
