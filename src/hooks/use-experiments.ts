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
import {
  experimentReadout,
  splitReadoutNotes,
  type ExperimentReadout,
} from '@/lib/experiments/readout';

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

/** What the detail screen draws for one experiment. */
export type ExperimentDetailView = {
  experiment: Experiment | null;
  /**
   * The numbers: computed live while it runs, the snapshot stored with the
   * verdict once concluded (never recomputed — the verdict cites what it saw),
   * and null for an abandoned one or a verdict that predates the snapshot.
   */
  readout: ExperimentReadout | null;
  /** `outcome_notes` with the stored readout split off — the Coach's words only. */
  notes: string | null;
};

function readDetail(id: string | undefined): ExperimentDetailView {
  const experiment = id ? getExperiment(getDb(), id) : null;
  if (!experiment) return { experiment: null, readout: null, notes: null };
  if (experiment.status === 'active') {
    return {
      experiment,
      readout: experimentReadout(getDb(), experiment, new Date()),
      notes: experiment.outcome_notes,
    };
  }
  const split = splitReadoutNotes(experiment.outcome_notes);
  return {
    experiment,
    readout: experiment.status === 'completed' ? split.readout : null,
    notes: split.notes,
  };
}

/** One experiment for the detail screen; `experiment` is null when the id no longer exists. */
export function useExperiment(
  id: string | undefined
): ExperimentDetailView & { reload: () => void } {
  const [view, setView] = useState<ExperimentDetailView>(() => readDetail(id));

  const reload = useCallback(() => {
    setView(readDetail(id));
  }, [id]);

  useFocusEffect(reload);

  return { ...view, reload };
}
