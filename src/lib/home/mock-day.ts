import type { HomeDay } from '@/types/home';

/**
 * MOCK DATA — delete once the Home Screen reads from Supabase.
 *
 * This models a **low recovery day** rather than a perfect one. That is the
 * state the design has to survive: the plan bends, the Coach explains why, and
 * the screen still answers "what do I do right now" in one glance. A flawless
 * day would flatter the layout and teach us nothing.
 *
 * The mission is a **flat, chronological list** — category is a label on each
 * row, not a grouping (owner call, 2026-07-24). Authored here in time order for
 * readability, but the derivation sorts regardless, so nothing depends on it.
 * This list is now also the **first-run seed** for the on-device DB (see
 * src/lib/db/seed.ts) — it's inserted into log_entries the first time the app
 * opens on a given day.
 *
 * The other states in docs/home-screen.md — travel, sick/deload, data-gappy,
 * first-run — are the next ones worth mocking.
 */
export const mockDay: HomeDay = {
  readiness: {
    level: 'caution',
    label: 'Recovery low',
    detail: 'HRV 42 ms · 14% below your 30-day baseline',
  },

  pillars: [
    { label: 'Sleep', level: 'good' },
    { label: 'Recovery', level: 'caution' },
    { label: 'Nutrition', level: 'optimal' },
    { label: 'Strain', level: 'good' },
  ],

  mission: [
    {
      id: 'light',
      title: 'Morning light — outside, no glasses',
      scheduledTime: '06:45',
      category: 'Morning',
      estimatedMinutes: 10,
      protocol: 'Circadian Base',
      status: 'completed',
    },
    {
      id: 'hydrate',
      title: 'Hydration + electrolytes',
      scheduledTime: '07:00',
      category: 'Morning',
      estimatedMinutes: 2,
      protocol: 'Circadian Base',
      status: 'completed',
    },
    {
      id: 'am-stack',
      title: 'AM stack — 6 items',
      scheduledTime: '07:15',
      category: 'Supplements',
      estimatedMinutes: 3,
      why: 'Creatine, omega-3, D3+K2, magnesium, B-complex, taurine. Take with fat.',
      protocol: 'Morning Stack v4',
      status: 'pending',
    },
    {
      id: 'breakfast',
      title: 'Breakfast — Protein Forward template',
      scheduledTime: '08:00',
      category: 'Nutrition',
      estimatedMinutes: 25,
      why: '45 g protein. Front-load today; you are eating dinner early.',
      protocol: 'Protein Forward',
      status: 'pending',
    },
    {
      id: 'lunch',
      title: 'Lunch — Template B',
      scheduledTime: '12:30',
      category: 'Nutrition',
      estimatedMinutes: 30,
      protocol: 'Protein Forward',
      status: 'pending',
    },
    {
      id: 'zone2',
      title: 'Zone 2 — 35 min, cap 135 bpm',
      scheduledTime: '17:00',
      category: 'Training',
      estimatedMinutes: 35,
      why: 'Strength moved to tomorrow. Keep this genuinely easy.',
      protocol: 'Base Block · Week 3',
      status: 'pending',
    },
    {
      id: 'dinner',
      title: 'Dinner — finish by 19:30',
      scheduledTime: '18:45',
      category: 'Nutrition',
      estimatedMinutes: 40,
      why: 'Late meals cost you deep sleep. This is the lever tonight.',
      protocol: 'Protein Forward',
      status: 'pending',
    },
    {
      id: 'sauna',
      title: 'Sauna — 20 min',
      scheduledTime: '19:45',
      category: 'Therapies',
      estimatedMinutes: 20,
      why: 'Optional today. Skip it if you feel flat after Zone 2.',
      protocol: 'Heat Adaptation',
      status: 'pending',
    },
    {
      id: 'screens',
      title: 'Screens off, lights dim',
      scheduledTime: '21:30',
      category: 'Evening',
      estimatedMinutes: 1,
      protocol: 'Sleep Protocol v2',
      status: 'pending',
    },
    {
      id: 'pm-stack',
      title: 'PM stack — 3 items',
      scheduledTime: '21:45',
      category: 'Supplements',
      estimatedMinutes: 2,
      protocol: 'Sleep Protocol v2',
      status: 'pending',
    },
    {
      id: 'bed',
      title: 'In bed',
      scheduledTime: '22:15',
      category: 'Evening',
      estimatedMinutes: 1,
      protocol: 'Sleep Protocol v2',
      status: 'pending',
    },
  ],

  brief:
    'Recovery is meaningfully down — HRV 42 ms against a 30-day baseline of 49, and resting ' +
    'heart rate is up 4 bpm. Sleep was adequate at 7h 12m but light-heavy, which tracks with ' +
    "Tuesday's late dinner. I have pulled today's strength session and moved it to tomorrow; " +
    'Zone 2 stays but capped at 135 bpm. The two highest-leverage moves today are eating ' +
    'dinner before 19:30 and being in bed by 22:15. If HRV is still suppressed tomorrow, we ' +
    'deload the rest of the week rather than push through it.',

  metrics: [
    { id: 'sleep', label: 'Sleep', value: '7h 12m', detail: 'Score 78 · Deep 51m', level: 'good' },
    { id: 'hrv', label: 'HRV', value: '42 ms', detail: '14% below baseline', level: 'caution' },
    { id: 'rhr', label: 'Resting HR', value: '58 bpm', detail: '+4 vs baseline', level: 'caution' },
    { id: 'steps', label: 'Steps', value: '3,240', detail: 'of 8,000', level: 'unknown' },
  ],
};
