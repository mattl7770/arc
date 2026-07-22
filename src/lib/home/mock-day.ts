import type { HomeDay } from '@/types/home';

/**
 * MOCK DATA — delete once the Home Screen reads from Supabase.
 *
 * This models a **low recovery day** rather than a perfect one. That is the
 * state the design has to survive: the plan bends, the Coach explains why, and
 * the screen still answers "what do I do right now" in one glance. A flawless
 * day would flatter the layout and teach us nothing.
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
      id: 'morning',
      title: 'Morning Protocol',
      items: [
        {
          id: 'light',
          title: 'Morning light — outside, no glasses',
          window: '06:45',
          estimatedMinutes: 10,
          protocol: 'Circadian Base',
          status: 'completed',
        },
        {
          id: 'hydrate',
          title: 'Hydration + electrolytes',
          window: '07:00',
          estimatedMinutes: 2,
          protocol: 'Circadian Base',
          status: 'completed',
        },
      ],
    },
    {
      id: 'supplements',
      title: 'Supplements & Medications',
      items: [
        {
          id: 'am-stack',
          title: 'AM stack — 6 items',
          window: '07:15',
          estimatedMinutes: 3,
          why: 'Creatine, omega-3, D3+K2, magnesium, B-complex, taurine. Take with fat.',
          protocol: 'Morning Stack v4',
          status: 'pending',
        },
        {
          id: 'pm-stack',
          title: 'PM stack — 3 items',
          window: '21:45',
          estimatedMinutes: 2,
          protocol: 'Sleep Protocol v2',
          status: 'pending',
        },
      ],
    },
    {
      id: 'nutrition',
      title: 'Nutrition',
      items: [
        {
          id: 'breakfast',
          title: 'Breakfast — Protein Forward template',
          window: '08:00',
          estimatedMinutes: 25,
          why: '45 g protein. Front-load today; you are eating dinner early.',
          protocol: 'Protein Forward',
          status: 'pending',
        },
        {
          id: 'lunch',
          title: 'Lunch — Template B',
          window: '12:30',
          estimatedMinutes: 30,
          protocol: 'Protein Forward',
          status: 'pending',
        },
        {
          id: 'dinner',
          title: 'Dinner — finish by 19:30',
          window: '18:45',
          estimatedMinutes: 40,
          why: 'Late meals cost you deep sleep. This is the lever tonight.',
          protocol: 'Protein Forward',
          status: 'pending',
        },
      ],
    },
    {
      id: 'training',
      title: 'Training',
      items: [
        {
          id: 'zone2',
          title: 'Zone 2 — 35 min, cap 135 bpm',
          window: '17:00',
          estimatedMinutes: 35,
          why: 'Strength moved to tomorrow. Keep this genuinely easy.',
          protocol: 'Base Block · Week 3',
          status: 'pending',
        },
      ],
    },
    {
      id: 'therapies',
      title: 'Therapies',
      items: [
        {
          id: 'sauna',
          title: 'Sauna — 20 min',
          window: '19:45',
          estimatedMinutes: 20,
          why: 'Optional today. Skip it if you feel flat after Zone 2.',
          protocol: 'Heat Adaptation',
          status: 'pending',
        },
      ],
    },
    {
      id: 'evening',
      title: 'Evening Wind-down',
      items: [
        {
          id: 'screens',
          title: 'Screens off, lights dim',
          window: '21:30',
          estimatedMinutes: 1,
          protocol: 'Sleep Protocol v2',
          status: 'pending',
        },
        {
          id: 'bed',
          title: 'In bed',
          window: '22:15',
          estimatedMinutes: 1,
          protocol: 'Sleep Protocol v2',
          status: 'pending',
        },
      ],
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
