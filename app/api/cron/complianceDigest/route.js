import { requireCron } from '@/lib/cronAuth';
import { loadOutreachSnapshot } from '@/lib/complianceOutreach';
import { buildTransporter } from '@/lib/studentEmails';

// Phase 0 — the INTERNAL weekly meeting-compliance digest (ship live).
//
// Emails Aaron (DIGEST_RECIPIENTS) one table over all active seniors: check-in
// status, essay tokens left, whether the ledger shows a booking this week/ahead, the
// calendar-mirror signal, a ledger<->cap DISAGREEMENT flag (data-health), dark-weeks,
// and the WOULD-FIRE column — which runs the exact same predicate the Phase-1 nudge
// uses, so this is the nudge's live dry-run. NO student/parent email is possible here.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const RECIPIENTS = (process.env.DIGEST_RECIPIENTS || 'aaron@sapientacademy.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const yn = (b) => (b ? 'yes' : '—');

function renderRows(rows) {
  // would-fire first, then data-health disagreements, then the rest, each by name.
  const rank = (r) => (r.phase1WouldFire ? 0 : r.ledgerCapDisagree ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function renderDigestHtml(rows, { thisWeekStart, wouldFire }) {
  const cell = (v, extra = '') => `<td style="padding:6px 10px;border-bottom:1px solid #eee;${extra}">${v}</td>`;
  const body = renderRows(rows).map((r) => {
    const bg = r.phase1WouldFire ? 'background:#fff4ec;' : r.ledgerCapDisagree ? 'background:#fbfbf4;' : '';
    return `<tr style="${bg}">
      ${cell(r.name + (r.capMissing ? ' ⚠' : ''), 'font-weight:600')}
      ${cell(`${r.package}/${r.primary}`)}
      ${cell(yn(r.essayOnly))}
      ${cell(yn(r.checkedInThisWeek))}
      ${cell(r.remaining)}
      ${cell(yn(r.bookedThisWeekAhead))}
      ${cell(yn(r.capHasMeeting))}
      ${cell(r.ledgerCapDisagree ? '⚠ disagree' : '—')}
      ${cell(r.darkWeeks == null ? 'none on file' : `${r.darkWeeks}w`)}
      ${cell(r.phase1WouldFire ? '<strong style="color:#c6613f">WOULD NUDGE</strong>' : '—')}
    </tr>`;
  }).join('');
  const head = ['Student', 'Pkg/Primary', 'Essay-only', 'Checked in', 'Tokens', 'Booked (ledger)', 'Cal meeting', 'Data health', 'Dark', 'Phase-1']
    .map((h) => `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #ddd;font-size:12px;color:#6f655d">${h}</th>`).join('');
  return `<div style="font:400 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
    <p style="margin:0 0 4px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#9a8f86">Senior meeting-compliance digest</p>
    <h2 style="margin:0 0 6px;font-size:20px">Week of ${thisWeekStart}</h2>
    <p style="margin:0 0 16px;color:#6f655d">${rows.length} active seniors · <strong>${wouldFire}</strong> would get an essay nudge (Phase-1 dry-run) · ⚠ = stale/missing calendar mirror.</p>
    <table style="border-collapse:collapse;width:100%;max-width:920px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <p style="margin:16px 0 0;font-size:12px;color:#9a8f86">"WOULD NUDGE" runs the exact Phase-1 predicate (essay-only · checked in · tokens left · no ledger booking this week/ahead · no calendar meeting). "Data health: disagree" = the booking ledger and the calendar mirror disagree about coverage (cap-lag or an off-portal hold) — worth a glance.</p>
  </div>`;
}

function renderDigestText(rows, thisWeekStart) {
  const lines = renderRows(rows).map((r) =>
    `${r.phase1WouldFire ? '»' : ' '} ${r.name} — ${r.package}/${r.primary} · checkedIn=${yn(r.checkedInThisWeek)} · tokens=${r.remaining} · bookedLedger=${yn(r.bookedThisWeekAhead)} · calMeeting=${yn(r.capHasMeeting)} · dark=${r.darkWeeks == null ? 'none' : r.darkWeeks + 'w'}${r.ledgerCapDisagree ? ' · ⚠disagree' : ''}${r.phase1WouldFire ? ' · WOULD-NUDGE' : ''}`);
  return `Senior meeting-compliance digest — week of ${thisWeekStart}\n\n${lines.join('\n')}\n`;
}

export async function GET(request) {
  const gate = requireCron(request);
  if (!gate.ok) return gate.response;

  const { rows, thisWeekStart } = await loadOutreachSnapshot();
  const wouldFire = rows.filter((r) => r.phase1WouldFire);
  const disagree = rows.filter((r) => r.ledgerCapDisagree);

  const transporter = buildTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_USER, // internal mail — NOT the autonomous channel
    to: RECIPIENTS,
    subject: `Senior meeting digest — week of ${thisWeekStart} · ${wouldFire.length} would-nudge`,
    html: renderDigestHtml(rows, { thisWeekStart, wouldFire: wouldFire.length }),
    text: renderDigestText(rows, thisWeekStart),
  });

  return Response.json({
    ok: true, week: thisWeekStart, seniors: rows.length,
    wouldFire: wouldFire.map((r) => r.name),
    dataHealthDisagreements: disagree.map((r) => r.name),
  });
}
