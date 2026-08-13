import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import type {
  CoachRead,
  DoctorPackData,
  ReportData,
  SelfReviewData,
} from '@/lib/reports/types';

import {
  AuthoredEmpty,
  BulletRow,
  FigureRows,
  GroupHeading,
  LedgerCells,
  Margin,
  MarginText,
  Provenance,
  RecordRow,
  ReportSection,
} from './blocks';

/**
 * The report, drawn natively — the in-app preview (docs/reports-subapp.md §2).
 *
 * **Not a WebView, and that is the load-bearing architectural choice.** It buys
 * no new native dependency (`react-native-webview` never enters the build
 * ledger), it makes the preview first-class UI — folds, VoiceOver, the paper —
 * and it is what makes the honesty guarantee structural: this component and
 * `render-html.ts` consume the same typed `ReportData`, and neither computes a
 * number, so they would have to be handed different data to disagree.
 *
 * Every string below is a field. See the header of ./blocks.tsx.
 */

// --- Self-review ---------------------------------------------------------------

function SelfReviewPreview({ data, read }: { data: SelfReviewData; read: CoachRead | null }) {
  const a = data.adherence;
  const t = data.training;
  const n = data.nutrition;
  const r = data.recovery;
  const b = data.body;
  const s = data.symptoms;
  const e = data.experiments;
  const c = data.changed;

  return (
    <View>
      {/* The folio line. Unruled — a hairline under one short line closes a box
          around it, and in this design rules enclose objects, never pages. */}
      <View className="pt-1">
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          Self-review
        </Text>
        <Text className="mt-1 font-serif text-[24px] font-semibold text-ink">
          {data.period.label}
        </Text>
        <Text className="mt-1 font-mono text-[11px] text-ink-muted">
          {data.period.rangeLabel} · generated {data.meta.generatedOn}
        </Text>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
          {data.coverageLine}
        </Text>
      </View>
      {data.todayNote ? <MarginText>{data.todayNote}</MarginText> : null}

      <ReportSection
        title={a.title}
        note={a.totals ? a.totals.completionLabel ?? 'no accountable items' : undefined}
        below={
          <>
            {a.modeNote ? <MarginText>{a.modeNote}</MarginText> : null}
            {a.reconciliation ? <MarginText>{a.reconciliation}</MarginText> : null}
            <Provenance provenance={a.provenance} />
          </>
        }>
        {() =>
          a.empty || a.totals == null ? (
            <AuthoredEmpty text={a.empty ?? 'No protocol was active this period.'} />
          ) : (
            <>
              {[...a.rows, a.totals].map((row, index) => (
                <View key={`${row.protocolName}-${index}`}>
                  <RecordRow
                    title={row.protocolName}
                    value={row.completionLabel}
                    first={index === 0}
                    emphasis={row === a.totals}
                  />
                  <View className="pb-3">
                    <LedgerCells
                      cells={[
                        { label: 'Planned', value: String(row.planned) },
                        { label: 'Done', value: String(row.completed) },
                        { label: 'Partial', value: String(row.partial) },
                        { label: 'Skipped', value: String(row.skipped) },
                        { label: 'Excused', value: String(row.excused) },
                        { label: 'Unmarked', value: String(row.unmarked) },
                      ]}
                    />
                  </View>
                </View>
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={t.title}
        below={
          <>
            {t.musclesNote ? <MarginText>{t.musclesNote}</MarginText> : null}
            <Provenance provenance={t.provenance} />
          </>
        }>
        {() =>
          t.empty ? (
            <AuthoredEmpty text={t.empty} />
          ) : (
            <>
              <FigureRows figures={t.headline} />
              {t.muscles.length > 0 ? (
                <>
                  <GroupHeading text="Set volume by muscle" note="vs the window before" />
                  {t.muscles.map((m, index) => (
                    <RecordRow
                      key={m.muscle}
                      title={m.muscle}
                      value={m.sets}
                      lines={[`${m.priorSets} before · ${m.delta}`]}
                      first={index === 0}
                    />
                  ))}
                </>
              ) : null}
              {t.movements.length > 0 ? (
                <>
                  <GroupHeading text="Estimated 1RM" note="≥ 2 sessions in period" />
                  {t.movements.map((m, index) => (
                    <RecordRow
                      key={m.exercise}
                      title={m.exercise}
                      value={m.last}
                      unit={m.unit}
                      lines={[
                        `${m.first} → ${m.last} ${m.unit} · ${m.delta} across ${String(m.sessions)} sessions`,
                      ]}
                      first={index === 0}
                    />
                  ))}
                </>
              ) : null}
              {t.personalRecords.length > 0 ? (
                <>
                  <GroupHeading text="Personal records set" />
                  {t.personalRecords.map((pr, index) => (
                    <BulletRow key={pr} text={pr} first={index === 0} />
                  ))}
                </>
              ) : null}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={n.title}
        note={n.coverageLine}
        below={
          <>
            {n.exclusionNote ? <MarginText>{n.exclusionNote}</MarginText> : null}
            {n.targetNote ? <MarginText>{n.targetNote}</MarginText> : null}
            <Provenance provenance={n.provenance} />
          </>
        }>
        {() => (n.empty ? <AuthoredEmpty text={n.empty} /> : <FigureRows figures={n.figures} />)}
      </ReportSection>

      <ReportSection
        title={r.title}
        below={<Provenance provenance={r.provenance} />}>
        {() =>
          r.empty ? (
            <AuthoredEmpty text={r.empty} />
          ) : (
            <>
              {r.rows.map((row, index) => (
                <RecordRow
                  key={row.metric}
                  title={row.metric}
                  value={row.periodAvg}
                  unit={row.unit || null}
                  emphasis={row.significant}
                  lines={[
                    row.priorAvg == null ? null : `${row.priorAvg} before · ${row.observations}`,
                    row.verdict,
                  ]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={b.title}
        below={
          <>
            <MarginText>{b.method}</MarginText>
            <Provenance provenance={b.provenance} />
          </>
        }>
        {() => (b.empty ? <AuthoredEmpty text={b.empty} /> : <FigureRows figures={b.figures} />)}
      </ReportSection>

      <ReportSection
        title={s.title}
        note={s.headline ?? undefined}
        below={<Provenance provenance={s.provenance} />}>
        {() =>
          s.empty ? (
            <AuthoredEmpty text={s.empty} />
          ) : (
            <>
              {s.rows.map((row, index) => (
                <RecordRow
                  key={row.name}
                  title={row.name}
                  value={String(row.count)}
                  unit="days"
                  lines={[`severity ${row.severityRange}`, row.dates]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={e.title}
        below={<Provenance provenance={e.provenance} />}>
        {() =>
          e.empty ? (
            <AuthoredEmpty text={e.empty} />
          ) : (
            <>
              {e.rows.map((row, index) => (
                <RecordRow
                  key={`${row.title}-${row.window}`}
                  title={row.title}
                  lines={[
                    `${row.state} · ${row.window}`,
                    row.intervention,
                    `Watching: ${row.metrics}`,
                    row.conclusion,
                  ]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      {/* Absent ENTIRELY when no draw falls in-period — labs are episodic, and a
          monthly "no labs" line is noise (spec §3a.9). */}
      {data.labs ? (
        <ReportSection
          title={data.labs.title}
          below={<Provenance provenance={data.labs.provenance} />}>
          {() => (
            <>
              <FigureRows figures={data.labs!.figures} />
              {data.labs!.draws.length > 0 ? (
                <>
                  <GroupHeading text="Draws in this period" />
                  {data.labs!.draws.map((draw, index) => (
                    <BulletRow key={draw} text={draw} first={index === 0} />
                  ))}
                </>
              ) : null}
            </>
          )}
        </ReportSection>
      ) : null}

      <ReportSection
        title={c.title}
        note={c.rows.length > 0 ? `${String(c.rows.length)} entries` : undefined}
        below={<Provenance provenance={c.provenance} />}>
        {() =>
          c.empty ? (
            <AuthoredEmpty text={c.empty} />
          ) : (
            <>
              {c.rows.map((row, index) => (
                <RecordRow
                  key={`${row.kind}-${row.what}-${row.when}`}
                  title={row.what}
                  lines={[`${row.kind} · ${row.when}`, row.note]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      {/* The ONE model surface, and only when the user asked for it. */}
      {read ? (
        <View className="mt-7">
          <Block device="plate">
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Coach&apos;s read
            </Text>
            <Text className="mt-3 font-serif text-[14.5px] leading-[22px] text-ink">
              {read.text}
            </Text>
          </Block>
          <MarginText>{read.attribution}</MarginText>
        </View>
      ) : null}

      <Disclaimer text={data.meta.disclaimer} />
    </View>
  );
}

// --- Doctor pack ----------------------------------------------------------------

function DoctorPackPreview({ data }: { data: DoctorPackData }) {
  const r = data.regimen;
  const l = data.labs;
  const v = data.vitals;
  const b = data.body;
  const sc = data.screenings;
  const sy = data.symptoms;

  return (
    <View>
      <View className="pt-1">
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          Prepared for a clinical visit
        </Text>
        <Text className="mt-1 font-serif text-[24px] font-semibold text-ink">
          {data.meta.title}
        </Text>
        <Text className="mt-1 font-mono text-[11px] text-ink-muted">As of {data.asOf}</Text>
      </View>

      <ReportSection title="Patient" note={data.patient.incomplete ? 'incomplete' : undefined}>
        {() => <FigureRows figures={data.patient.fields} />}
      </ReportSection>

      <ReportSection
        title={r.title}
        below={<Provenance provenance={r.provenance} />}>
        {() =>
          r.empty ? (
            <AuthoredEmpty text={r.empty} />
          ) : (
            <>
              {r.groups.map((group) => (
                <View key={group.type}>
                  <GroupHeading text={group.type} />
                  {group.protocols.map((protocol) => (
                    <View key={protocol.name}>
                      <RecordRow
                        title={protocol.name}
                        value={protocol.version}
                        lines={[
                          `started ${protocol.started} · last revised ${protocol.lastRevised}`,
                          protocol.note,
                        ]}
                        first
                        emphasis
                      />
                      {protocol.items.map((item) => (
                        <RecordRow
                          key={`${protocol.name}-${item.title}-${item.schedule ?? ''}`}
                          title={item.title}
                          value={item.dose}
                          lines={[item.schedule]}
                        />
                      ))}
                    </View>
                  ))}
                </View>
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={l.title}
        note={l.coverageLine}
        below={
          <>
            <MarginText>{l.optimalRangeLabel}</MarginText>
            <Provenance provenance={l.provenance} />
          </>
        }>
        {() =>
          l.empty ? (
            <AuthoredEmpty text={l.empty} />
          ) : (
            <>
              {l.groups.map((group) => (
                <View key={group.category}>
                  <GroupHeading text={group.category} note={`${String(group.rows.length)} markers`} />
                  {group.rows.map((row, index) => (
                    <RecordRow
                      key={row.name}
                      title={row.outsideStandard ? `${row.name} — outside range` : row.name}
                      value={row.value}
                      unit={row.unit || null}
                      emphasis={row.outsideStandard}
                      lines={[
                        `${row.collected} · reference ${row.standardRange} · personal target ${row.optimalRange}`,
                        row.trendNote ? `${row.trend} ${row.trendNote}` : null,
                      ]}
                      first={index === 0}
                    />
                  ))}
                </View>
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={v.title}
        below={
          <>
            <MarginText>{v.notMeasured}</MarginText>
            <Provenance provenance={v.provenance} />
          </>
        }>
        {() =>
          v.empty ? (
            <AuthoredEmpty text={v.empty} />
          ) : (
            <>
              {v.rows.map((row, index) => (
                <RecordRow
                  key={row.metric}
                  title={row.metric}
                  value={row.latest}
                  unit={row.unit || null}
                  lines={[
                    row.latestOn ? `taken ${row.latestOn}${row.source ? ` · ${row.source}` : ''}` : null,
                    row.average30 ? `30-day average ${row.average30}` : null,
                  ]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={b.title}
        below={
          <>
            <MarginText>{b.method}</MarginText>
            <Provenance provenance={b.provenance} />
          </>
        }>
        {() => (b.empty ? <AuthoredEmpty text={b.empty} /> : <FigureRows figures={b.figures} />)}
      </ReportSection>

      <ReportSection
        title={sc.title}
        below={<Provenance provenance={sc.provenance} />}>
        {() =>
          sc.empty ? (
            <AuthoredEmpty text={sc.empty} />
          ) : (
            <>
              {sc.rows.map((row, index) => (
                <RecordRow
                  key={row.name}
                  title={row.name}
                  value={row.status}
                  emphasis={row.overdue}
                  lines={[`${row.category} · last done ${row.lastDone} · next due ${row.nextDue}`]}
                  first={index === 0}
                />
              ))}
              {sc.upcoming.length > 0 ? (
                <>
                  <GroupHeading text="Upcoming appointments" />
                  {sc.upcoming.map((line, index) => (
                    <BulletRow key={line} text={line} first={index === 0} />
                  ))}
                </>
              ) : null}
            </>
          )
        }
      </ReportSection>

      <ReportSection
        title={sy.title}
        note={sy.headline ?? undefined}
        below={<Provenance provenance={sy.provenance} />}>
        {() =>
          sy.empty ? (
            <AuthoredEmpty text={sy.empty} />
          ) : (
            <>
              {sy.rows.map((row, index) => (
                <RecordRow
                  key={row.name}
                  title={row.name}
                  value={String(row.count)}
                  unit="days"
                  lines={[`severity ${row.severityRange}`, row.dates]}
                  first={index === 0}
                />
              ))}
            </>
          )
        }
      </ReportSection>

      <Disclaimer text={data.meta.disclaimer} />
    </View>
  );
}

function Disclaimer({ text }: { text: string }) {
  return (
    <View className="mt-7">
      <Margin>
        <Text className="font-serif text-[11.5px] leading-[17px] text-ink-secondary">{text}</Text>
      </Margin>
    </View>
  );
}

/**
 * The preview. `read` is passed separately — never as a field on `data` — for
 * the same reason `renderReportHtml` takes it separately: the deterministic
 * snapshot persisted to `reports.data_json` must never carry model text, and a
 * field on the data object is exactly how it would end up there. The doctor
 * pack's renderer takes no such parameter at all.
 */
export function ReportPreview({
  data,
  read = null,
}: {
  data: ReportData;
  read?: CoachRead | null;
}) {
  return data.kind === 'self_review' ? (
    <SelfReviewPreview data={data} read={read} />
  ) : (
    <DoctorPackPreview data={data} />
  );
}
