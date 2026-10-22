/**
 * Provider-side web search (2026-10-21, items 62 and 91; the ADR is
 * "Provider-side web search" in docs/decisions.md).
 *
 * Owner, verbatim: *"web search in food logging + coach in general"*. His call:
 * the model searches **whenever it thinks it helps**, in Coach chat and in the
 * food estimators. The search is Anthropic's SERVER tool: the query runs at the
 * provider, inside the same model call ARC already makes, so the phone's only
 * egress is still that one call (CLAUDE.md §3).
 *
 * PURE, like model-client.ts: no expo, no database. The tool definition, the
 * per-model choice of its version, and the reading of what came back all live
 * here so db/model-client.test.mjs can drive them with a scripted stream.
 *
 * ## The wire, as documented (not guessed)
 *
 * - The model calls it as a `server_tool_use` block (`id` prefixed `srvtoolu_`,
 *   `input.query`), streamed like a `tool_use` block: `input_json_delta`s.
 * - Its result is a `web_search_tool_result` block, complete in one
 *   `content_block_start`, paired by `tool_use_id`. `content` is a LIST of
 *   `web_search_result` ({url, title, encrypted_content, page_age}) on success
 *   and a single `web_search_tool_result_error` OBJECT on failure, so the shape
 *   is branched on, never indexed blindly.
 * - Citations ride text blocks as `web_search_result_location`
 *   ({url, title, cited_text, encrypted_index}), streamed as `citations_delta`.
 * - Every one of those blocks goes back VERBATIM on a continuation of the same
 *   turn (`encrypted_content` / `encrypted_index` must survive byte for byte, or
 *   the API returns a 400). The model client already echoes a reply's blocks
 *   unchanged; nothing here rewrites one.
 * - Across turns ARC replays prose plus a tool DIGEST (history-window.ts), never
 *   raw blocks, so nothing encrypted is ever stored. What is stored is the
 *   query and the domains, in the turn's `tool_calls` JSON (no migration).
 */
import type { CoachToolCall } from './types';

/** The server tool's fixed name. No registry tool may take it (a test holds that). */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

/**
 * Searches one Coach turn may run. The tool docs put a simple factual lookup at
 * one to three searches; a Coach question that needs the web at all is that
 * shape (a menu, a product, a recent result), and three lets it refine a miss
 * twice. Each search is ~1¢ plus its results as input tokens, so the cap is also
 * the most one question can add: ~3¢ and a few thousand tokens.
 */
export const COACH_WEB_SEARCH_MAX_USES = 3;

/**
 * Searches one estimate, revision or food description may run. A meal names one
 * or two things worth looking up (a chain's burger, a packaged bar), and the
 * second use is the retry with a better query. The estimate is a one-shot call
 * the user is WAITING on in the review screen, so the cap also bounds latency.
 */
export const ESTIMATOR_WEB_SEARCH_MAX_USES = 2;

/** What a caller asks for: the search tool, capped. Absent or null = no search. */
export type WebSearchOptions = { maxUses: number };

/** The web search server tool, in the Messages API `tools` shape. */
export type WireServerTool = {
  type: string;
  name: string;
  max_uses: number;
};

/**
 * Which tool version each model takes. `web_search_20260209` is the current
 * version on Sonnet 5 and Opus 5; Haiku 4.5 takes the basic
 * `web_search_20250305` (the claude-api skill's server-tools table).
 *
 * The documented shape is `{ type, name: 'web_search' }` with optional
 * `max_uses`, `allowed_domains` / `blocked_domains` and `user_location`; this
 * sends `max_uses` and nothing else. Until 2026-10-21 it also sent
 * `allowed_callers: ['direct']`, meant to turn the newer version's dynamic
 * filtering off. The docs say otherwise: filtering is built into
 * `web_search_20260209` and "activates automatically", and `['direct']` is the
 * field's DEFAULT (the API treats it as identical to the field absent). So it
 * bought nothing, and an extra field is one more thing a request can be
 * refused for. With filtering on, a reply may carry blocks beyond the two the
 * ledger reads; the client echoes every block verbatim and the ledger skips
 * what it does not know, so nothing here has to model them.
 *
 * A model missing from this table gets NO search rather than a guessed version:
 * a wrong tool type is a 400 that takes the whole turn down with it. That is
 * also the answer for any provider the seam might one day route to — today
 * every selectable model is a Claude model (model-client.ts COACH_MODELS).
 * A key that cannot use the tool at all is model-client.ts's
 * `searchToolRefused`: one retry without it, then off for the session.
 */
const TOOL_VERSION_BY_MODEL: Record<string, string> = {
  'claude-sonnet-5': 'web_search_20260209',
  'claude-opus-5': 'web_search_20260209',
  'claude-haiku-4-5': 'web_search_20250305',
};

/** The server tool for `model`, or null when that model has no known version. */
export function webSearchTool(model: string, maxUses: number): WireServerTool | null {
  const type = TOOL_VERSION_BY_MODEL[model];
  if (!type) return null;
  return { type, name: WEB_SEARCH_TOOL_NAME, max_uses: maxUses };
}

// --- Reading what came back ---------------------------------------------------

/** A reply block, opaque except for the fields read here. */
type Block = { type: string } & Record<string, unknown>;

/** What one search is recorded as, inside `CoachToolCall.result` (JSON). */
type SearchResultRecord = {
  query: string;
  /** Domains the reply CITED from this search's results, in order. */
  cited: string[];
  /** Domains the search returned, in result order. */
  found: string[];
  /** The API's error code when the search failed; absent on success. */
  error?: string;
};

type LedgerEntry = {
  call: CoachToolCall;
  data: SearchResultRecord;
  urls: Set<string>;
  resolved: boolean;
};

/** How many domains a record keeps: enough to say where, not a link dump. */
const MAX_FOUND = 5;
const MAX_CITED = 3;

/** "https://www.mcdonalds.co.nz/menu" → "mcdonalds.co.nz"; '' when unparseable. */
export function domainOf(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  if (!match) return '';
  return match[1]!.toLowerCase().replace(/^www\./, '');
}

function pushUnique(list: string[], value: string, cap: number): void {
  if (value !== '' && !list.includes(value) && list.length < cap) list.push(value);
}

/**
 * Collects a turn's searches as it streams, across every round-trip of it.
 *
 * A search and its result can land in DIFFERENT replies: when the model calls a
 * client tool in the same group as a search, the API stops with `tool_use`, the
 * `server_tool_use` has no result yet, and the result block opens the next
 * reply. So records are keyed by the server tool id for the whole turn, not per
 * reply.
 *
 * The records are `CoachToolCall`s (name {@link WEB_SEARCH_TOOL_NAME}) so they
 * ride the existing `ai_messages.tool_calls` JSON column with no migration, and
 * the next turn's digest (history-window.ts) tells the model what it searched.
 *
 * A search is not only a block named exactly `web_search` (fix4). A name that
 * starts with it is read as one at once, and any other `server_tool_use` is
 * held by its id: when a `web_search_tool_result` answers it, it WAS a search,
 * and is recorded then. Another server tool that no search result answers is
 * never recorded, so nothing else is passed off as a search.
 */
export class WebSearchLedger {
  private readonly records = new Map<string, LedgerEntry>();
  /** Server tool calls not (yet) known to be searches, by id, for the whole turn. */
  private readonly unnamed = new Map<string, Block>();

  /** Record one search block; null when it has no id or is already recorded. */
  private record(id: string, block: Block): CoachToolCall | null {
    if (id === '' || this.records.has(id)) return null;
    const input = block.input as { query?: unknown } | undefined;
    const query = typeof input?.query === 'string' ? input.query : '';
    const call: CoachToolCall = {
      id,
      name: WEB_SEARCH_TOOL_NAME,
      input: { query },
      result: '',
    };
    this.records.set(id, {
      call,
      data: { query, cited: [], found: [] },
      urls: new Set(),
      resolved: false,
    });
    return call;
  }

  /** The records in the order their searches were made. */
  calls(): CoachToolCall[] {
    return [...this.records.values()].map(({ call }) => call);
  }

  /** Fold one reply's blocks in. Returns the records first seen in this reply. */
  observe(blocks: readonly Block[]): CoachToolCall[] {
    const added: CoachToolCall[] = [];
    for (const block of blocks) {
      if (block.type === 'server_tool_use') {
        const id = typeof block.id === 'string' ? block.id : '';
        if (typeof block.name === 'string' && block.name.startsWith(WEB_SEARCH_TOOL_NAME)) {
          const call = this.record(id, block);
          if (call) added.push(call);
        } else if (id !== '') {
          this.unnamed.set(id, block);
        }
      } else if (block.type === 'web_search_tool_result') {
        const useId = String(block.tool_use_id ?? '');
        const held = this.unnamed.get(useId);
        if (held && !this.records.has(useId)) {
          const call = this.record(useId, held);
          if (call) added.push(call);
        }
        const entry = this.records.get(useId);
        if (!entry) continue;
        entry.resolved = true;
        const content = block.content;
        if (Array.isArray(content)) {
          for (const result of content as Block[]) {
            if (result.type !== 'web_search_result' || typeof result.url !== 'string') continue;
            entry.urls.add(result.url);
            pushUnique(entry.data.found, domainOf(result.url), MAX_FOUND);
          }
        } else if (content && typeof content === 'object') {
          const code = (content as { error_code?: unknown }).error_code;
          entry.data.error = typeof code === 'string' ? code : 'unavailable';
        }
      } else if (block.type === 'text' && Array.isArray(block.citations)) {
        for (const citation of block.citations as Block[]) {
          if (citation.type !== 'web_search_result_location' || typeof citation.url !== 'string') {
            continue;
          }
          for (const entry of this.records.values()) {
            if (entry.urls.has(citation.url)) {
              pushUnique(entry.data.cited, domainOf(citation.url), MAX_CITED);
            }
          }
        }
      }
    }
    this.flush();
    return added;
  }

  /**
   * Seal the ledger at the end of a turn. A search still without a result
   * never ran (the turn stopped first), and says so rather than reading as an
   * empty success.
   */
  finish(): CoachToolCall[] {
    for (const entry of this.records.values()) {
      if (!entry.resolved && entry.data.error === undefined) entry.data.error = 'no_result';
    }
    this.flush();
    return this.calls();
  }

  private flush(): void {
    for (const { call, data } of this.records.values()) {
      call.result = JSON.stringify(data);
      if (data.error !== undefined) call.isError = true;
      else delete call.isError;
    }
  }
}

/** One search, as the UI draws it. */
export type WebSearchSummary = {
  query: string;
  /** The cited domains when the reply cited any, else the top ones found. */
  sources: string[];
  /** True when the search failed or never ran. */
  failed: boolean;
};

/** Is this tool record a web search (rather than a registry tool)? */
export function isWebSearchCall(call: Pick<CoachToolCall, 'name'>): boolean {
  return call.name === WEB_SEARCH_TOOL_NAME;
}

/**
 * The searches in a turn's tool record, for the "Searched" line. Reads only what
 * {@link WebSearchLedger} wrote, and tolerates anything else: a corrupt row
 * draws nothing rather than throwing on a reload.
 */
export function webSearchesOf(calls: readonly CoachToolCall[] | undefined): WebSearchSummary[] {
  const out: WebSearchSummary[] = [];
  for (const call of calls ?? []) {
    if (!isWebSearchCall(call)) continue;
    let data: Partial<SearchResultRecord> = {};
    try {
      const parsed = JSON.parse(call.result) as unknown;
      if (parsed && typeof parsed === 'object') data = parsed as Partial<SearchResultRecord>;
    } catch {
      // Unreadable record: fall back to the input's query below.
    }
    const input = call.input as { query?: unknown } | null;
    const query =
      typeof data.query === 'string' && data.query !== ''
        ? data.query
        : typeof input?.query === 'string'
          ? input.query
          : '';
    if (query === '') continue;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
    const cited = strings(data.cited);
    const found = strings(data.found);
    out.push({
      query,
      sources: cited.length > 0 ? cited : found.slice(0, 2),
      failed: call.isError === true,
    });
  }
  return out;
}

/** "Searched “big mac nz” · mcdonalds.co.nz" — the one line format, everywhere. */
export function searchedLine(search: WebSearchSummary): string {
  const tail = search.failed
    ? 'no result'
    : search.sources.length > 0
      ? search.sources.join(', ')
      : 'nothing found';
  return `Searched “${search.query}” · ${tail}`;
}
