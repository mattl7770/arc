import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { currentStatuses, subscribeStatusChange } from '@/lib/status/store';
import type { DayStatusRow } from '@/lib/db/repositories/statuses';

/**
 * Today's running statuses, for any surface that draws them.
 *
 * Same shape as use-readiness: a synchronous first
 * read in the useState initializer (op-sqlite is sync), a re-read on focus, and
 * a subscription for in-place changes. The subscription is the one that matters
 * — the sheet is presented OVER whichever screen opened it, Home or the Coach
 * tab, so neither loses focus and `useFocusEffect` alone would leave the door
 * naming what was on before the tap.
 */
export function useStatuses(): { open: DayStatusRow[]; reload: () => void } {
  const [open, setOpen] = useState<DayStatusRow[]>(currentStatuses);
  const reload = useCallback(() => setOpen(currentStatuses()), []);
  useFocusEffect(reload);
  useEffect(() => subscribeStatusChange(reload), [reload]);
  return { open, reload };
}
