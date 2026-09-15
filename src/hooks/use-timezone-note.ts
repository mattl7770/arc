import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { timezoneHomeLine } from '@/lib/db/repositories/day-meta';

/**
 * Home's timezone line (D4) — *"Timezone changed (UTC−8 → UTC+1). Today is 15
 * hours long."* — or `null`, which is what it returns on every day but one.
 *
 * Same shape as use-mode / use-readiness: a synchronous first read in the
 * useState initializer (op-sqlite is sync) and a re-read on focus. Focus matters
 * here specifically — the observer runs on foreground, so a landing while ARC is
 * resident writes the row and Home regains focus immediately afterwards.
 *
 * Fails to `null` rather than throwing. A line about the calendar is the least
 * important thing on this screen, and Home is the screen that must always
 * render.
 */
function read(): string | null {
  try {
    return timezoneHomeLine(getDb(), todayISODate());
  } catch {
    return null;
  }
}

export function useTimezoneNote(): string | null {
  const [line, setLine] = useState<string | null>(read);
  const reload = useCallback(() => setLine(read()), []);
  useFocusEffect(reload);
  return line;
}
