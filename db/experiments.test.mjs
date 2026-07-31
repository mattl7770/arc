/**
 * Headless test of n-of-1 experiments (0027) against real SQLite via node:sqlite:
 * the experiments repository + the real create_experiment / get_experiments /
 * complete_experiment Coach tools. op-sqlite / the model client are never loaded.
 * Run: npm run db:test.
 */
import { DatabaseSync } from 'node:sqlite';

import { todayISODate } from '../src/lib/db/date.ts';
import { migrate } from '../src/lib/db/migrate.ts';
import { MIGRATIONS } from '../src/lib/db/migrations.generated.ts';
import {
  abandonExperiment,
  activeExperiments,
  completeExperiment,
  createExperiment,
  getExperiment,
  listExperiments,
} from '../src/lib/db/repositories/experiments.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

function makeDb(raw) {
  return {
    run: (sql, params = []) => {
      raw.prepare(sql).run(...params);
    },
    all: (sql, params = []) => raw.prepare(sql).all(...params),
    get: (sql, params = []) => raw.prepare(sql).get(...params),
    transaction: (fn) => {
      raw.exec('BEGIN');
      try {
        fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = makeDb(raw);
  migrate(
    {
      exec: (sql) => raw.exec(sql),
      getUserVersion: () => raw.prepare('PRAGMA user_version').get().user_version,
      setUserVersion: (n) => raw.exec(`PRAGMA user_version = ${n}`),
      transaction: db.transaction,
    },
    MIGRATIONS
  );
  return { raw, db };
}

console.log('0. createExperiment: end_date from duration, metrics JSON, active status');
{
  const { db } = freshDb();
  const id = createExperiment(db, {
    title: 'Evening magnesium → sleep',
    hypothesis: '400 mg magnesium improves HRV + sleep',
    intervention: '400 mg magnesium glycinate at 21:00',
    metrics: ['HRV', 'sleep score'],
    startDate: '2026-08-01',
    durationDays: 14,
    successCriteria: 'HRV up ≥5% vs baseline',
  });
  const exp = getExperiment(db, id);
  exp &&
  exp.status === 'active' &&
  exp.start_date === '2026-08-01' &&
  exp.end_date === '2026-08-14' && // start + (14 - 1)
  Array.isArray(exp.metrics) &&
  exp.metrics.length === 2 &&
  exp.metrics[0] === 'HRV'
    ? ok('created active, end_date = start + (duration-1), metrics parsed to an array')
    : bad('create', JSON.stringify(exp));

  throws(() =>
    createExperiment(db, {
      title: 'x',
      hypothesis: 'y',
      intervention: 'z',
      metrics: ['m'],
      startDate: '2026-08-01',
      durationDays: 0,
    })
  )
    ? ok('a non-positive duration is rejected')
    : bad('bad duration accepted');
}

console.log('1. activeExperiments: ready when the window has closed, daysLeft otherwise');
{
  const { db } = freshDb();
  createExperiment(db, {
    title: 'ongoing',
    hypothesis: 'h',
    intervention: 'i',
    metrics: ['HRV'],
    startDate: '2026-08-01',
    durationDays: 30,
  });
  createExperiment(db, {
    title: 'finished',
    hypothesis: 'h',
    intervention: 'i',
    metrics: ['RHR'],
    startDate: '2026-08-01',
    durationDays: 7, // ends 2026-08-07
  });
  const today = '2026-08-20';
  const active = activeExperiments(db, today);
  const ongoing = active.find((e) => e.title === 'ongoing');
  const finished = active.find((e) => e.title === 'finished');
  ongoing && ongoing.ready === false && ongoing.daysLeft > 0
    ? ok('an in-progress experiment is not ready and reports daysLeft')
    : bad('ongoing', JSON.stringify(ongoing));
  finished && finished.ready === true
    ? ok('an experiment whose window closed is ready for readout')
    : bad('finished', JSON.stringify(finished));
}

console.log('2. complete + abandon transition status and record the readout');
{
  const { db } = freshDb();
  const a = createExperiment(db, {
    title: 'a',
    hypothesis: 'h',
    intervention: 'i',
    metrics: ['HRV'],
    startDate: '2026-08-01',
    durationDays: 14,
  });
  const b = createExperiment(db, {
    title: 'b',
    hypothesis: 'h',
    intervention: 'i',
    metrics: ['HRV'],
    startDate: '2026-08-01',
    durationDays: 14,
  });
  completeExperiment(db, a, { conclusion: 'HRV up 9% — supported', outcomeNotes: 'clear signal' });
  abandonExperiment(db, b, 'got sick, confound');

  const done = getExperiment(db, a);
  const dropped = getExperiment(db, b);
  done.status === 'completed' &&
  done.conclusion === 'HRV up 9% — supported' &&
  dropped.status === 'abandoned' &&
  dropped.outcome_notes === 'got sick, confound'
    ? ok('complete → completed + conclusion; abandon → abandoned + reason')
    : bad('transitions', JSON.stringify({ done, dropped }));
  listExperiments(db, 'active').length === 0
    ? ok('neither remains in the active list')
    : bad('still active');
}

console.log('3. create_experiment Coach tool (was a stub) creates + validates');
{
  const { db } = freshDb();
  const now = new Date(2026, 7, 1); // 2026-08-01
  const ctx = { now };
  const tool = toolByName('create_experiment');
  tool && !tool.readOnly && toolByName('set_mode')
    ? ok('create_experiment is a registered write tool (no longer a stub)')
    : bad('not registered');

  const summary = tool.confirmSummary(
    {
      name: 'Cold plunge → mood',
      hypothesis: 'h',
      intervention: 'i',
      metrics: ['mood'],
      duration_days: 21,
    },
    db
  );
  summary === 'Start experiment "Cold plunge → mood" — 21 days'
    ? ok(`confirmation names the experiment + duration ("${summary}")`)
    : bad('confirm', summary);

  const out = JSON.parse(
    tool.execute(
      db,
      {
        name: 'Cold plunge → mood',
        hypothesis: 'cold plunges lift mood',
        intervention: 'AM cold plunge 3 min',
        metrics: ['mood', 'HRV'],
        duration_days: 21,
      },
      ctx
    )
  );
  const created = getExperiment(db, out.id);
  out.created === true &&
  created.start_date === todayISODate(now) &&
  created.end_date === '2026-08-21' &&
  created.metrics.length === 2
    ? ok('execute starts the experiment today for the duration, with its metrics')
    : bad('execute', JSON.stringify({ out, created }));

  throws(() =>
    tool.execute(
      db,
      { name: 'x', hypothesis: 'h', intervention: 'i', metrics: [], duration_days: 7 },
      ctx
    )
  )
    ? ok('empty metrics rejected')
    : bad('empty metrics accepted');
  throws(() =>
    tool.execute(
      db,
      { name: 'x', hypothesis: 'h', intervention: 'i', metrics: ['m'], duration_days: 1 },
      ctx
    )
  )
    ? ok('a duration under 3 days is rejected')
    : bad('short duration accepted');
}

console.log('4. get_experiments + complete_experiment tools close the loop');
{
  const { db } = freshDb();
  const now = new Date(2026, 7, 20); // 2026-08-20
  const ctx = { now };
  createExperiment(db, {
    title: 'mag',
    hypothesis: 'h',
    intervention: 'i',
    metrics: ['HRV'],
    startDate: '2026-08-01',
    durationDays: 7, // ended 08-07, ready
  });

  const view = JSON.parse(toolByName('get_experiments').execute(db, {}, ctx));
  view.active.length === 1 && view.active[0].ready === true && view.active[0].title === 'mag'
    ? ok('get_experiments surfaces the active experiment as ready for readout')
    : bad('get_experiments', JSON.stringify(view));

  const complete = toolByName('complete_experiment');
  const cSummary = complete.confirmSummary({ id: view.active[0].id, conclusion: 'x' }, db);
  cSummary === 'Conclude experiment "mag"'
    ? ok(`complete confirmation names the target ("${cSummary}")`)
    : bad('complete confirm', cSummary);

  complete.execute(
    db,
    { id: view.active[0].id, conclusion: 'HRV up 6% — supported', outcome_notes: 'steady rise' },
    ctx
  );
  const after = JSON.parse(
    toolByName('get_experiments').execute(db, { include_completed: true }, ctx)
  );
  after.active.length === 0 &&
  after.completed.length === 1 &&
  after.completed[0].conclusion === 'HRV up 6% — supported'
    ? ok('after complete_experiment it leaves active and appears under completed with its verdict')
    : bad('post-complete', JSON.stringify(after));

  throws(() => complete.execute(db, { id: 'nope', conclusion: 'x' }, ctx))
    ? ok('concluding an unknown id is rejected with guidance')
    : bad('unknown id accepted');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
