import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  activeExperiments,
  getExperiment,
  listExperiments,
  type Experiment,
} from '@/lib/db/repositories/experiments';

export type ActiveExperiment = Experiment & { ready: boolean; daysLeft: number };

export type ExperimentsView = {
  active: ActiveExperiment[];
  concluded: Experiment[];
  abandoned: Experiment[];
  isEmpty: boolean;
  reload: () => void;
};

function read(): Omit<ExperimentsView, 'reload'> {
  const db = getDb();
  const active = activeExperiments(db, todayISODate());
  const concluded = listExperiments(db, 'completed');
  const abandoned = listExperiments(db, 'abandoned');
  return {
    active,
    concluded,
    abandoned,
    isEmpty: active.length === 0 && concluded.length === 0 && abandoned.length === 0,
  };
}

/**
 * The Experiments screen's view model. Synchronous first read in the useState
 * initializer (op-sqlite is sync — no async, no spinner, the house pattern),
 * re-read on focus so returning from the detail screen shows a fresh verdict.
 */
export function useExperiments(): ExperimentsView {
  const [state, setState] = useState(read);

  const reload = useCallback(() => {
    setState(read());
  }, []);

  useFocusEffect(reload);

  return { ...state, reload };
}

/** One experiment for the detail screen; null when the id no longer exists. */
export function useExperiment(id: string | undefined): {
  experiment: Experiment | null;
  reload: () => void;
} {
  const [experiment, setExperiment] = useState<Experiment | null>(() =>
    id ? getExperiment(getDb(), id) : null
  );

  const reload = useCallback(() => {
    setExperiment(id ? getExperiment(getDb(), id) : null);
  }, [id]);

  useFocusEffect(reload);

  return { experiment, reload };
}
