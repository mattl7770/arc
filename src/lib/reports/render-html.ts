/**
 * The report as one self-contained HTML document — the file that leaves the
 * device (docs/reports-subapp.md §2).
 *
 * **Self-contained is a hard requirement, not a preference.** No external
 * stylesheet, no font URL, no image, no script. The doctor opens this from a
 * mail attachment on a machine that may have no network and certainly has no
 * relationship with ARC; anything fetched is a broken document, and anything
 * scripted is a security question nobody should have to ask about a medical
 * handout. The `@media print` block is what makes Safari/Files → Print → Save
 * as PDF produce clean paged output, which is the v1 PDF path. `expo-print`
 * is in the binary as of the owner's 2026-08-25 EAS build, but nothing here
 * uses it yet (⚑ MATT #1, decided yes 2026-08-12).
 *
 * ## THIS FILE COMPUTES NOTHING
 *
 * That is the rule the whole architecture rests on (see ./types.ts). Every
 * figure below is a field on {@link ReportData}, already rounded, already
 * converted, already worded by the assembly layer. There is no arithmetic
 * operator in this file, no `toFixed`, no `Math.`, no date handling — only
 * `escapeHtml`, string concatenation, and `null` checks that choose between a
 * value and the em-dash the assembler put there.
 *
 * It is what makes "the preview and the file cannot disagree" structural: the
 * native preview (src/components/reports/) draws the SAME fields, so the two
 * renderers would have to be handed different data to differ, and they are
 * handed the same object.
 *
 * The one thing this file does own is ESCAPING. Protocol names, symptom names,
 * change notes and the Coach's read are user- and model-authored text going
 * into markup; every one of them crosses through {@link escapeHtml}.
 */
import type {
  AdherenceRow,
  CoachRead,
  DoctorPackData,
  Figure,
  ReportData,
  SectionProvenance,
  SelfReviewData,
} from './types';

/**
 * The five characters that can break out of markup or an attribute. `&` first —
 * escaping it after the others would double-escape the entities they produce.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A value or the em-dash — the assembler decides which; this only places it. */
function cell(value: string | null): string {
  return value == null ? '<span class="absent">—</span>' : escapeHtml(value);
}

/**
 * The document's stylesheet. Bone stock on screen (the Conformed Set's own
 * paper), plain white on paper — a full-bleed background tint is a courtesy to
 * nobody's toner. Serif for reading, a system mono for every measurement, and
 * the tracked-caps label voice for section names: the app's three voices, in
 * font stacks that exist on any machine because nothing may be fetched.
 */
const STYLES = `
:root {
  --paper: #f5f3ec;
  --ink: #1c1911;
  --ink-secondary: #443f30;
  --ink-muted: #5c5340;
  --rule: #a9a28e;
  --rule-soft: #d9d5c8;
  --accent: #2f5d5b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 32px 24px 64px;
  background: var(--paper);
  color: var(--ink);
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 15px;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}
.sheet { max-width: 46rem; margin: 0 auto; }
.eyebrow {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 10px; font-weight: 600; letter-spacing: 1.2px;
  text-transform: uppercase; color: var(--ink-muted); margin: 0 0 6px;
}
h1 { font-size: 27px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.2px; }
.subtitle { color: var(--ink-secondary); margin: 0 0 4px; }
.meta { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px; color: var(--ink-muted); margin: 0; }
.head { border-bottom: 1px solid var(--rule); padding-bottom: 16px; margin-bottom: 28px; }
section { margin: 0 0 30px; break-inside: auto; }
h2 {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 11px; font-weight: 700; letter-spacing: 1.3px; text-transform: uppercase;
  color: var(--ink-muted); margin: 0 0 10px; padding-bottom: 6px;
  border-bottom: 1px solid var(--rule-soft);
  break-after: avoid;
}
h3 {
  font-size: 15px; font-weight: 600; margin: 18px 0 6px; break-after: avoid;
}
p { margin: 0 0 10px; }
.empty { color: var(--ink-secondary); font-style: italic; margin: 0; }
.note { font-size: 13px; color: var(--ink-secondary); margin: 8px 0 0; }
.coverage { font-size: 13px; color: var(--ink-secondary); margin: 0 0 10px; }
.absent { color: var(--ink-muted); }
.mono, td.mono, th.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
table { width: 100%; border-collapse: collapse; margin: 6px 0 0; font-size: 13.5px; }
th {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase;
  color: var(--ink-muted); text-align: left; padding: 0 8px 5px 0;
  border-bottom: 1px solid var(--rule);
}
td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
tr:last-child td { border-bottom: none; }
th.n, td.n { text-align: right; padding-right: 0; }
tfoot td { border-top: 1px solid var(--rule); border-bottom: none; font-weight: 700; }
tbody tr, thead { break-inside: avoid; }
.figures { display: flex; flex-wrap: wrap; gap: 0; margin: 4px 0 0;
           border-top: 1px solid var(--rule-soft); }
.figure { flex: 1 1 30%; min-width: 9rem; padding: 9px 12px 9px 0;
          border-bottom: 1px solid var(--rule-soft); }
.figure .k {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase;
  color: var(--ink-muted); display: block;
}
.figure .v { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
             font-size: 19px; font-variant-numeric: tabular-nums; }
/* The unit suffix, selected on the class ALONE rather than only under .figure:
   the recovery and vitals tables put a unit beside a value inside a table cell,
   and scoping this rule to the figure grid left those unstyled — a unit set at
   the value's own size and weight reads as part of the number.
   (No backticks anywhere in this stylesheet: it is a template literal, and a
   backtick in a CSS comment terminates the string. It has done so once.) */
.u { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
     font-size: 11px; color: var(--ink-muted); margin-left: 3px; }
.figure .n { display: block; font-size: 11.5px; color: var(--ink-secondary); margin-top: 2px; }
ul { margin: 6px 0 0; padding-left: 18px; }
li { margin: 0 0 3px; }
.flag { font-weight: 700; }
.rule-legend { font-size: 11.5px; color: var(--ink-secondary); margin: 8px 0 0;
               padding-left: 10px; border-left: 2px solid var(--rule); }
.provenance {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px; color: var(--ink-muted); margin: 8px 0 0;
}
.narrative { padding-left: 12px; border-left: 2px solid var(--accent); margin-top: 6px; }
.narrative .rubric { font-size: 11.5px; color: var(--ink-secondary); margin: 0 0 8px; }
.narrative p { white-space: pre-wrap; }
.disclaimer {
  margin-top: 36px; padding-top: 14px; border-top: 1px solid var(--rule);
  font-size: 11.5px; color: var(--ink-secondary);
}
@media print {
  @page { margin: 16mm 14mm; }
  body { background: #fff; padding: 0; font-size: 10.5pt; }
  .sheet { max-width: none; }
  h1 { font-size: 20pt; }
  section { break-inside: auto; }
  h2, h3 { break-after: avoid; }
  table { font-size: 9.5pt; }
  .figure { break-inside: avoid; }
  .disclaimer { break-before: avoid; }
}
`;

// --- Small placers (no computation, only choice) -------------------------------

function figuresBlock(figures: Figure[]): string {
  if (figures.length === 0) return '';
  const cells = figures
    .map(
      (f) =>
        `<div class="figure"><span class="k">${escapeHtml(f.label)}</span>` +
        `<span class="v">${cell(f.value)}</span>` +
        (f.unit ? `<span class="u">${escapeHtml(f.unit)}</span>` : '') +
        (f.note ? `<span class="n">${escapeHtml(f.note)}</span>` : '') +
        `</div>`
    )
    .join('');
  return `<div class="figures">${cells}</div>`;
}

function provenanceBlock(p: SectionProvenance): string {
  return `<p class="provenance">Source: ${escapeHtml(p.sources)} · ${escapeHtml(p.range)}</p>`;
}

function section(title: string, body: string, provenance?: SectionProvenance): string {
  return (
    `<section><h2>${escapeHtml(title)}</h2>${body}` +
    (provenance ? provenanceBlock(provenance) : '') +
    `</section>`
  );
}

function emptyLine(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function noteLine(text: string | null): string {
  return text ? `<p class="note">${escapeHtml(text)}</p>` : '';
}

function list(items: string[]): string {
  if (items.length === 0) return '';
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

/** One adherence row — the same cells in the body and in the totals foot. */
function adherenceCells(row: AdherenceRow): string {
  return (
    `<td>${escapeHtml(row.protocolName)}</td>` +
    `<td class="n mono">${escapeHtml(String(row.planned))}</td>` +
    `<td class="n mono">${escapeHtml(String(row.completed))}</td>` +
    `<td class="n mono">${escapeHtml(String(row.partial))}</td>` +
    `<td class="n mono">${escapeHtml(String(row.skipped))}</td>` +
    `<td class="n mono">${escapeHtml(String(row.excused))}</td>` +
    `<td class="n mono">${escapeHtml(String(row.unmarked))}</td>` +
    `<td class="n mono">${cell(row.completionLabel)}</td>`
  );
}

function narrativeBlock(read: CoachRead | null): string {
  if (read == null) return '';
  return section(
    "Coach's read",
    `<div class="narrative"><p class="rubric">${escapeHtml(read.attribution)}</p>` +
      `<p>${escapeHtml(read.text)}</p></div>`,
    {
      sources: read.model ? `language model (${read.model})` : 'language model',
      range: 'written over the figures in this report',
    }
  );
}

// --- Self-review ---------------------------------------------------------------

function renderSelfReview(data: SelfReviewData, read: CoachRead | null): string {
  const parts: string[] = [];

  parts.push(
    `<div class="head">` +
      `<p class="eyebrow">ARC · Self-review</p>` +
      `<h1>${escapeHtml(data.period.label)}</h1>` +
      `<p class="subtitle">${escapeHtml(data.period.rangeLabel)}</p>` +
      `<p class="meta">Generated ${escapeHtml(data.meta.generatedOn)}` +
      (data.meta.appVersion ? ` · ARC ${escapeHtml(data.meta.appVersion)}` : '') +
      `</p></div>`
  );
  parts.push(`<p class="coverage">${escapeHtml(data.coverageLine)}</p>`);
  if (data.todayNote) parts.push(`<p class="rule-legend">${escapeHtml(data.todayNote)}</p>`);

  // 2. Adherence
  {
    const a = data.adherence;
    let body: string;
    if (a.empty || a.rows.length === 0 || a.totals == null) {
      body = emptyLine(a.empty ?? 'No protocol was active this period.');
    } else {
      body =
        `<table><thead><tr><th>Protocol</th><th class="n">Planned</th><th class="n">Done</th>` +
        `<th class="n">Partial</th><th class="n">Skipped</th><th class="n">Excused</th>` +
        `<th class="n">Unmarked</th><th class="n">Completion</th></tr></thead><tbody>` +
        a.rows.map((r) => `<tr>${adherenceCells(r)}</tr>`).join('') +
        `</tbody><tfoot><tr>${adherenceCells(a.totals)}</tr></tfoot></table>` +
        noteLine(a.modeNote) +
        (a.reconciliation ? `<p class="rule-legend">${escapeHtml(a.reconciliation)}</p>` : '');
    }
    parts.push(section(a.title, body, a.provenance));
  }

  // 3. Training
  {
    const t = data.training;
    let body: string;
    if (t.empty) {
      body = emptyLine(t.empty);
    } else {
      body = figuresBlock(t.headline);
      if (t.muscles.length > 0) {
        body +=
          `<h3>Set volume by muscle</h3>` +
          `<table><thead><tr><th>Muscle</th><th class="n">Sets</th>` +
          `<th class="n">Window before</th><th class="n">Change</th></tr></thead><tbody>` +
          t.muscles
            .map(
              (m) =>
                `<tr><td>${escapeHtml(m.muscle)}</td>` +
                `<td class="n mono">${escapeHtml(m.sets)}</td>` +
                `<td class="n mono">${escapeHtml(m.priorSets)}</td>` +
                `<td class="n mono">${escapeHtml(m.delta)}</td></tr>`
            )
            .join('') +
          `</tbody></table>` +
          noteLine(t.musclesNote);
      }
      if (t.movements.length > 0) {
        body +=
          `<h3>Estimated 1RM by movement</h3>` +
          `<table><thead><tr><th>Movement</th><th class="n">Sessions</th><th class="n">First</th>` +
          `<th class="n">Last</th><th class="n">Change</th></tr></thead><tbody>` +
          t.movements
            .map(
              (m) =>
                `<tr><td>${escapeHtml(m.exercise)}</td>` +
                `<td class="n mono">${escapeHtml(String(m.sessions))}</td>` +
                `<td class="n mono">${escapeHtml(m.first)}</td>` +
                `<td class="n mono">${escapeHtml(m.last)}</td>` +
                `<td class="n mono">${escapeHtml(m.delta)} ${escapeHtml(m.unit)}</td></tr>`
            )
            .join('') +
          `</tbody></table>`;
      }
      if (t.personalRecords.length > 0) {
        body += `<h3>Personal records set this period</h3>${list(t.personalRecords)}`;
      }
    }
    parts.push(section(t.title, body, t.provenance));
  }

  // 4. Nutrition — the coverage line comes FIRST, before any average.
  {
    const n = data.nutrition;
    const body = n.empty
      ? `<p class="coverage">${escapeHtml(n.coverageLine)}</p>${emptyLine(n.empty)}`
      : `<p class="coverage">${escapeHtml(n.coverageLine)}</p>` +
        figuresBlock(n.figures) +
        noteLine(n.exclusionNote) +
        noteLine(n.targetNote);
    parts.push(section(n.title, body, n.provenance));
  }

  // 5. Sleep & recovery
  {
    const r = data.recovery;
    const body = r.empty
      ? emptyLine(r.empty)
      : `<table><thead><tr><th>Metric</th><th class="n">This period</th>` +
        `<th class="n">Window before</th><th class="n">Days</th><th>Reading</th></tr></thead><tbody>` +
        r.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.metric)}</td>` +
              `<td class="n mono">${cell(row.periodAvg)}${row.unit ? ` <span class="u">${escapeHtml(row.unit)}</span>` : ''}</td>` +
              `<td class="n mono">${cell(row.priorAvg)}</td>` +
              `<td class="n mono">${escapeHtml(row.observations)}</td>` +
              `<td${row.significant ? ' class="flag"' : ''}>${escapeHtml(row.verdict)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`;
    parts.push(section(r.title, body, r.provenance));
  }

  // 6. Body composition
  {
    const b = data.body;
    const body = b.empty
      ? emptyLine(b.empty)
      : figuresBlock(b.figures) + `<p class="rule-legend">${escapeHtml(b.method)}</p>`;
    parts.push(section(b.title, body, b.provenance));
  }

  // 7. Symptoms
  {
    const s = data.symptoms;
    const body = s.empty
      ? emptyLine(s.empty)
      : (s.headline ? `<p class="coverage">${escapeHtml(s.headline)}</p>` : '') +
        `<table><thead><tr><th>Symptom</th><th class="n">Days</th><th class="n">Severity</th>` +
        `<th>Dates</th></tr></thead><tbody>` +
        s.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.name)}</td>` +
              `<td class="n mono">${escapeHtml(String(row.count))}</td>` +
              `<td class="n mono">${escapeHtml(row.severityRange)}</td>` +
              `<td class="mono">${escapeHtml(row.dates)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`;
    parts.push(section(s.title, body, s.provenance));
  }

  // 8. Experiments
  {
    const e = data.experiments;
    const body = e.empty
      ? emptyLine(e.empty)
      : `<table><thead><tr><th>Experiment</th><th>State</th><th>Intervention</th>` +
        `<th>Watching</th><th class="mono">Window</th></tr></thead><tbody>` +
        e.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.title)}` +
              (row.conclusion ? `<br><span class="n">${escapeHtml(row.conclusion)}</span>` : '') +
              `</td><td>${escapeHtml(row.state)}</td>` +
              `<td>${escapeHtml(row.intervention)}</td>` +
              `<td>${escapeHtml(row.metrics)}</td>` +
              `<td class="mono">${escapeHtml(row.window)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`;
    parts.push(section(e.title, body, e.provenance));
  }

  // 9. New labs — absent ENTIRELY when there was no draw in-period.
  if (data.labs) {
    const l = data.labs;
    const body =
      figuresBlock(l.figures) +
      (l.draws.length > 0 ? `<h3>Draws in this period</h3>${list(l.draws)}` : '');
    parts.push(section(l.title, body, l.provenance));
  }

  // 10. What changed
  {
    const c = data.changed;
    const body = c.empty
      ? emptyLine(c.empty)
      : `<table><thead><tr><th>Kind</th><th>What</th><th class="mono">When</th></tr></thead><tbody>` +
        c.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.kind)}</td>` +
              `<td>${escapeHtml(row.what)}` +
              (row.note ? `<br><span class="n">${escapeHtml(row.note)}</span>` : '') +
              `</td><td class="mono">${escapeHtml(row.when)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`;
    parts.push(section(c.title, body, c.provenance));
  }

  // 11. The Coach's read — the ONE model surface, and only when asked for.
  parts.push(narrativeBlock(read));

  parts.push(`<p class="disclaimer">${escapeHtml(data.meta.disclaimer)}</p>`);
  return parts.join('');
}

// --- Doctor pack ----------------------------------------------------------------

function renderDoctorPack(data: DoctorPackData): string {
  const parts: string[] = [];

  parts.push(
    `<div class="head">` +
      `<p class="eyebrow">ARC · Prepared for a clinical visit</p>` +
      `<h1>${escapeHtml(data.meta.title)}</h1>` +
      `<p class="subtitle">As of ${escapeHtml(data.asOf)}</p>` +
      (data.meta.appVersion ? `<p class="meta">ARC ${escapeHtml(data.meta.appVersion)}</p>` : '') +
      `</div>`
  );

  parts.push(section('Patient', figuresBlock(data.patient.fields)));

  {
    const r = data.regimen;
    let body: string;
    if (r.empty) {
      body = emptyLine(r.empty);
    } else {
      body = r.groups
        .map(
          (group) =>
            `<h3>${escapeHtml(group.type)}</h3>` +
            group.protocols
              .map((p) => {
                const head =
                  `<p class="meta">${escapeHtml(p.name)} · ${escapeHtml(p.version)} · ` +
                  `started ${escapeHtml(p.started)} · last revised ${escapeHtml(p.lastRevised)}</p>`;
                if (p.note) return head + emptyLine(p.note);
                return (
                  head +
                  `<table><thead><tr><th>Item</th><th>Dose / detail</th>` +
                  `<th class="n">Time</th></tr></thead><tbody>` +
                  p.items
                    .map(
                      (item) =>
                        `<tr><td>${escapeHtml(item.title)}</td>` +
                        `<td>${cell(item.dose)}</td>` +
                        `<td class="n mono">${cell(item.schedule)}</td></tr>`
                    )
                    .join('') +
                  `</tbody></table>`
                );
              })
              .join('')
        )
        .join('');
    }
    parts.push(section(r.title, body, r.provenance));
  }

  {
    const l = data.labs;
    let body = `<p class="coverage">${escapeHtml(l.coverageLine)}</p>`;
    if (l.empty) {
      body += emptyLine(l.empty);
    } else {
      body += l.groups
        .map(
          (group) =>
            `<h3>${escapeHtml(group.category)}</h3>` +
            `<table><thead><tr><th>Marker</th><th class="n">Result</th><th class="n">Unit</th>` +
            `<th class="n">Collected</th><th class="n">Reference range</th>` +
            `<th class="n">Personal target</th><th class="n">Trend</th></tr></thead><tbody>` +
            group.rows
              .map(
                (row) =>
                  `<tr><td${row.outsideStandard ? ' class="flag"' : ''}>${escapeHtml(row.name)}` +
                  (row.outsideStandard ? ' *' : '') +
                  `</td>` +
                  `<td class="n mono${row.outsideStandard ? ' flag' : ''}">${escapeHtml(row.value)}</td>` +
                  `<td class="n mono">${escapeHtml(row.unit)}</td>` +
                  `<td class="n mono">${escapeHtml(row.collected)}</td>` +
                  `<td class="n mono">${escapeHtml(row.standardRange)}</td>` +
                  `<td class="n mono">${escapeHtml(row.optimalRange)}</td>` +
                  `<td class="n mono">${escapeHtml(row.trend)}` +
                  (row.trendNote ? `<br><span class="n">${escapeHtml(row.trendNote)}</span>` : '') +
                  `</td></tr>`
              )
              .join('') +
            `</tbody></table>`
        )
        .join('');
      body +=
        `<p class="rule-legend">* outside the laboratory reference range. ` +
        `“Personal target”: ${escapeHtml(l.optimalRangeLabel)}</p>`;
    }
    parts.push(section(l.title, body, l.provenance));
  }

  {
    const v = data.vitals;
    const body =
      (v.empty
        ? emptyLine(v.empty)
        : `<table><thead><tr><th>Measure</th><th class="n">Latest</th><th class="n">Taken</th>` +
          `<th class="n">30-day average</th><th>Source</th></tr></thead><tbody>` +
          v.rows
            .map(
              (row) =>
                `<tr><td>${escapeHtml(row.metric)}</td>` +
                `<td class="n mono">${cell(row.latest)}${row.unit ? ` <span class="u">${escapeHtml(row.unit)}</span>` : ''}</td>` +
                `<td class="n mono">${cell(row.latestOn)}</td>` +
                `<td class="n mono">${cell(row.average30)}</td>` +
                `<td>${cell(row.source)}</td></tr>`
            )
            .join('') +
          `</tbody></table>`) + `<p class="rule-legend">${escapeHtml(v.notMeasured)}</p>`;
    parts.push(section(v.title, body, v.provenance));
  }

  {
    const b = data.body;
    const body = b.empty
      ? emptyLine(b.empty)
      : figuresBlock(b.figures) + `<p class="rule-legend">${escapeHtml(b.method)}</p>`;
    parts.push(section(b.title, body, b.provenance));
  }

  {
    const s = data.screenings;
    let body: string;
    if (s.empty) {
      body = emptyLine(s.empty);
    } else {
      body =
        s.rows.length > 0
          ? `<table><thead><tr><th>Screening</th><th>Category</th><th class="n">Last done</th>` +
            `<th class="n">Next due</th><th>Status</th></tr></thead><tbody>` +
            s.rows
              .map(
                (row) =>
                  `<tr><td>${escapeHtml(row.name)}</td>` +
                  `<td>${escapeHtml(row.category)}</td>` +
                  `<td class="n mono">${escapeHtml(row.lastDone)}</td>` +
                  `<td class="n mono">${escapeHtml(row.nextDue)}</td>` +
                  `<td${row.overdue ? ' class="flag"' : ''}>${escapeHtml(row.status)}</td></tr>`
              )
              .join('') +
            `</tbody></table>`
          : '';
      if (s.upcoming.length > 0) body += `<h3>Upcoming appointments</h3>${list(s.upcoming)}`;
    }
    parts.push(section(s.title, body, s.provenance));
  }

  {
    const s = data.symptoms;
    const body = s.empty
      ? emptyLine(s.empty)
      : (s.headline ? `<p class="coverage">${escapeHtml(s.headline)}</p>` : '') +
        `<table><thead><tr><th>Symptom</th><th class="n">Days</th><th class="n">Severity</th>` +
        `<th>Dates</th></tr></thead><tbody>` +
        s.rows
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.name)}</td>` +
              `<td class="n mono">${escapeHtml(String(row.count))}</td>` +
              `<td class="n mono">${escapeHtml(row.severityRange)}</td>` +
              `<td class="mono">${escapeHtml(row.dates)}</td></tr>`
          )
          .join('') +
        `</tbody></table>`;
    parts.push(section(s.title, body, s.provenance));
  }

  parts.push(`<p class="disclaimer">${escapeHtml(data.meta.disclaimer)}</p>`);
  return parts.join('');
}

/**
 * The whole document. `read` is the Coach's prose, or null — it is passed
 * SEPARATELY rather than living on {@link ReportData} because the deterministic
 * snapshot persisted to `reports.data_json` must never carry model text
 * (spec §5), and a field on the data object is exactly how it would end up
 * there. The doctor pack ignores it entirely: `renderDoctorPack` takes no such
 * parameter, so "no model prose in the doctor pack" is a fact about the
 * function signature rather than a branch someone could invert.
 */
export function renderReportHtml(data: ReportData, read: CoachRead | null = null): string {
  const body =
    data.kind === 'self_review' ? renderSelfReview(data, read) : renderDoctorPack(data);
  const title =
    data.kind === 'self_review'
      ? `ARC self-review — ${data.period.rangeLabel}`
      : `ARC doctor visit pack — ${data.asOf}`;
  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>${STYLES}</style>\n</head>\n` +
    `<body><div class="sheet">${body}</div></body>\n</html>\n`
  );
}

/**
 * `arc-report-self-review-20260812-143308.html` — the export convention
 * (`exportFileName` in src/lib/export/serializer.ts), with the report type in
 * the slot the word "export" occupies there.
 *
 * Second precision, so a same-second re-run overwrites: for identical content
 * that is the right dedupe, and it is the behaviour export already has.
 */
export function reportFileName(type: ReportData['kind'], generatedAt: string): string {
  const slug = type === 'self_review' ? 'self-review' : 'doctor';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(generatedAt);
  if (!match) return `arc-report-${slug}.html`;
  const [, y, mo, d, h, mi, s] = match;
  return `arc-report-${slug}-${y}${mo}${d}-${h}${mi}${s}.html`;
}
