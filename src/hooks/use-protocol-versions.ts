import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import {
  getProtocol,
  listVersions,
  type ProtocolVersionListItem,
} from '@/lib/db/repositories/protocols';
import type { ProtocolRow } from '@/lib/db/types';

export type ProtocolHistory = {
  protocol: ProtocolRow;
  /** Every saved version, newest first. */
  versions: ProtocolVersionListItem[];
  /** What `current_version_id` points at — null while a protocol has none. */
  currentVersionId: string | null;
};

function read(id: string | undefined): ProtocolHistory | null {
  if (!id) return null;
  const db = getDb();
  const protocol = getProtocol(db, id);
  if (!protocol) return null;
  return {
    protocol,
    versions: listVersions(db, id),
    currentVersionId: protocol.current_version_id,
  };
}

/**
 * One protocol's version history, backed by the on-device database.
 *
 * Same shape as use-protocols / use-log-feed: op-sqlite is synchronous, so the
 * first read runs in the `useState` initializer (there is no loading state to
 * draw), and `useFocusEffect` re-reads on every focus — returning here after a
 * save in the editor must show the version that save just wrote.
 *
 * `id` undefined or unknown reads as null, which the screen draws as "this
 * protocol no longer exists" rather than an empty timeline.
 */
export function useProtocolVersions(id: string | undefined): ProtocolHistory | null {
  const [history, setHistory] = useState<ProtocolHistory | null>(() => read(id));

  const reload = useCallback(() => {
    setHistory(read(id));
  }, [id]);

  useFocusEffect(reload);

  return history;
}
