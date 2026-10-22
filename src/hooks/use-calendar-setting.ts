import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import {
  calendarAccess,
  calendarModuleAvailable,
  requestCalendarAccess,
  type CalendarAccess,
} from '@/lib/calendar/calendar';
import { clearCalendarCache } from '@/lib/calendar/context';
import { getDb } from '@/lib/db/client';
import { getCalendarContextOn, setCalendarContextOn } from '@/lib/db/repositories/calendar-setting';

/**
 * The Calendar switch: his choice (the preferences blob), iOS's answer, and the
 * change handler that asks iOS before storing an ON. iOS is asked for its
 * answer only while the switch is ON (the ADR: off, not even a permission
 * check); off, the only question is whether this build has the module.
 */
export function useCalendarSetting(): [boolean, CalendarAccess | null, (on: boolean) => void] {
  const [on, setOn] = useState(() => getCalendarContextOn(getDb()));
  const [access, setAccess] = useState<CalendarAccess | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const check = () => {
      void calendarAccess().then((next) => {
        if (live) setAccess(next);
      });
    };
    check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, [on]);
  const change = useCallback((next: boolean) => {
    clearCalendarCache();
    if (!next) {
      setAccess(null);
      setOn(setCalendarContextOn(getDb(), false));
      return;
    }
    void requestCalendarAccess().then((answer) => {
      setAccess(answer);
      if (answer === 'granted') setOn(setCalendarContextOn(getDb(), true));
    });
  }, []);
  // Off and not yet answered: the only fact on hand is whether this build has
  // the module, which asks iOS nothing.
  const shown = !on && access === null && !calendarModuleAvailable() ? 'unavailable' : access;
  return [on, shown, change];
}
