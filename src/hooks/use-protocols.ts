import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { getCurrentVersion, getProtocol, listProtocols } from '@/lib/db/repositories/protocols';
import type { ProtocolRow, ProtocolVersionRow } from '@/lib/db/types';
import { parseProtocolContent } from '@/lib/protocols/content';
import type { ProtocolContent, ProtocolListItem } from '@/lib/protocols/types';

export type Protocols = {
  protocols: ProtocolListItem[];
  /** Re-read the list — call after an in-screen save/delete. */
  reload: () => void;
};

/**
 * The Protocols list, backed by the on-device database.
 *
 * Same shape as use-log-feed: op-sqlite is synchronous, so the first read runs
 * in the `useState` initializer (no loading state), and `useFocusEffect`
 * re-reads whenever the screen regains focus — e.g. returning from the editor
 * after a save.
 */
export function useProtocols(): Protocols {
  const [protocols, setProtocols] = useState<ProtocolListItem[]>(() => listProtocols(getDb()));

  const reload = useCallback(() => {
    setProtocols(listProtocols(getDb()));
  }, []);

  useFocusEffect(reload);

  return { protocols, reload };
}

export type ProtocolDetail = {
  protocol: ProtocolRow;
  /** The live version row, or null while the protocol has no version yet. */
  version: ProtocolVersionRow | null;
  /** The live version's parsed content ({ items: [] } when version is null). */
  content: ProtocolContent;
};

function readDetail(id: string | undefined): ProtocolDetail | null {
  if (!id) return null;
  const db = getDb();
  const protocol = getProtocol(db, id);
  if (!protocol) return null;
  const version = getCurrentVersion(db, id) ?? null;
  return { protocol, version, content: parseProtocolContent(version?.content) };
}

/**
 * One protocol + its live version for the editor. `id` undefined (the create
 * path) or unknown reads as null. Same initializer + focus-refresh pattern;
 * the editor seeds its form fields from the first read only, so the refresh
 * never clobbers in-progress edits.
 */
export function useProtocol(id: string | undefined): ProtocolDetail | null {
  const [detail, setDetail] = useState<ProtocolDetail | null>(() => readDetail(id));

  const reload = useCallback(() => {
    setDetail(readDetail(id));
  }, [id]);

  useFocusEffect(reload);

  return detail;
}
