/**
 * The weekly review, run — the one impure step between the schedule
 * (weekly-review.ts) and the pass (coach-pass.ts).
 *
 * Called by the pass store's one runner (pass-store.ts), after the lock, the
 * key and the Health sync have all been settled there, so this inherits every
 * gate the other passes have. In order:
 *
 *   1. THE REPORT. Last week's self-review, assembled by `assembleSelfReview`
 *      — the function Data › Reports calls — so its figures are the screen's
 *      figures for the same week, by construction rather than by a copy.
 *   2. THE READ. One pass (`runCoachPass` with `weekly`), on the pass's own
 *      model and read tools. It returns the read, every line's numbers traced,
 *      and its PROPOSE lines drawn as cards by the tools themselves. Nothing
 *      executes.
 *   3. THE FILING. The report row, with the read in `narrative_text` — the
 *      column the opt-in Coach's read uses, never `data_json` — then the
 *      decisions through the weekly allowance, then the week stamped done,
 *      then the thread. A failure to REACH the model files nothing and leaves
 *      the week due; a SKIP files the report with no read.
 *
 * The row is filed WITHOUT a file on disk. A report's file is a hand-off
 * artefact, regenerated from `data_json` by "Share again" (reports §5); an
 * unattended run has no share sheet to offer it to, and writing whole health
 * data to disk for nobody would be the wrong default. Its `file_name` /
 * `file_path` are the names the file will have when he shares it.
 *
 * Never a doctor pack: the only assembler this module imports is the
 * self-review's, and the read only ever reaches a `self_review` row.
 */
import type { Database } from '@/lib/db/database';
import { getDayStartsAt, shiftISODate, todayISODate } from '@/lib/db/date';
import { appendMessage, getOrCreateActiveConversation } from '@/lib/db/repositories/ai-chat';
import { insertReport } from '@/lib/db/repositories/reports';
import { assembleSelfReview } from '@/lib/reports/assemble-self-review';
import { COACH_READ_ATTRIBUTION } from '@/lib/reports/coach-read';
import { reportFileName } from '@/lib/reports/render-html';
import { reportRelativePath } from '@/lib/reports/report-file';

import { runCoachPass } from './coach-pass';
import type { FetchLike } from './model-client';
import {
  describeProposalRecord,
  linkProposalsToMessage,
  noteProposalsChanged,
  recordProposals,
} from './proposals';
import {
  dueWeekly,
  markWeekReviewed,
  reportForModel,
  WEEKLY_DECISIONS,
  weeklyProposalDirectiveFor,
  weeklyThreadHead,
} from './weekly-review';

/**
 * What happened: `null` nothing was due; `baseline` the first sight was
 * recorded; `ran` a read was filed; `silent` the report was filed with no
 * read; `offline` the model was not reached and the week is still due.
 */
export type WeeklyOutcome = 'baseline' | 'ran' | 'silent' | 'offline' | null;

/** The app's version for the report's header, through a guarded require. */
function appVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constants = require('expo-constants') as {
      default?: { expoConfig?: { version?: string } | null };
    };
    return constants.default?.expoConfig?.version ?? null;
  } catch {
    return null;
  }
}

export async function runWeeklyIfDue(
  db: Database,
  options: { now: Date; fetchImpl?: FetchLike }
): Promise<WeeklyOutcome> {
  const { now } = options;
  const due = dueWeekly(db, now);
  if (!due) return null;
  const week = due.period.start;
  if (due.baseline) {
    markWeekReviewed(db, week, null);
    return 'baseline';
  }

  const data = assembleSelfReview(db, due.period, { now, appVersion: appVersion() });
  const reportJson = reportForModel(data);
  const result = await runCoachPass(db, {
    trigger: { kind: 'weekly', rangeLabel: data.period.rangeLabel },
    now,
    weekly: {
      rangeLabel: data.period.rangeLabel,
      reportJson,
      proposals: weeklyProposalDirectiveFor(db, now, week),
    },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (result.status === 'failed') return 'offline';

  const read = result.weeklyRead ?? null;
  const fileName = reportFileName(data.kind, data.meta.generatedAt);
  const reportId = insertReport(db, {
    data,
    read: read ? { text: read.join('\n'), attribution: COACH_READ_ATTRIBUTION, model: null } : null,
    fileName,
    filePath: reportRelativePath(fileName),
  });

  const today = todayISODate(now, getDayStartsAt());
  const kept = recordProposals(db, result.proposals.drafted, result.proposals.refused, now, {
    weekly: { week, through: shiftISODate(today, 1), allowance: WEEKLY_DECISIONS },
  });

  // Stamped BEFORE the thread: a retry after a failed append would file the
  // report twice, and a missing thread row costs less than a duplicate record.
  markWeekReviewed(db, week, {
    weekStart: data.period.start,
    weekEnd: data.period.end,
    day: today,
    reportId,
    at: now.toISOString(),
  });

  const drafts = describeProposalRecord(kept);
  if (read || drafts) {
    try {
      const content = [
        [weeklyThreadHead(data.period.rangeLabel), ...(read ?? [])].join('\n'),
        ...(drafts ? [drafts] : []),
      ].join('\n\n');
      const messageId = appendMessage(
        db,
        getOrCreateActiveConversation(db).id,
        'assistant',
        content,
        result.toolCalls.length > 0 ? result.toolCalls : null
      );
      linkProposalsToMessage(
        db,
        kept.map((proposal) => proposal.id),
        messageId
      );
    } catch {
      // The report and the decisions stand on Home and in Data › Reports.
    }
  }
  noteProposalsChanged();
  return read ? 'ran' : 'silent';
}
