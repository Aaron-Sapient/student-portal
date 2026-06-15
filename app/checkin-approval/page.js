import { verifyApprovalToken } from '@/lib/checkinApproval';
import ApprovalConfirm from './ApprovalConfirm';

export const metadata = { title: 'Meeting approval' };

// Ryan lands here from a grant/reject button in the check-in email. This GET
// page only *verifies the signature and shows* the decision — it never mutates
// (so a Gmail/Workspace link-scanner prefetching the URL can't fire an action).
// The actual write happens on a deliberate POST from ApprovalConfirm.

const ACTION_COPY = {
  grant15: { title: 'Grant a 15-minute meeting', verb: 'Confirm: grant 15-min', tone: 'grant' },
  grant30: { title: 'Grant a 30-minute meeting', verb: 'Confirm: grant 30-min', tone: 'grant' },
  reject: { title: 'Decline a meeting', verb: 'Confirm: reject meeting', tone: 'reject' },
};

function Shell({ children }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-5 py-10">
      <div className="neu-raised w-full max-w-md rounded-3xl p-7 sm:p-8">{children}</div>
    </main>
  );
}

export default async function CheckinApprovalPage({ searchParams }) {
  const sp = await searchParams;
  const token = typeof sp?.t === 'string' ? sp.t : '';
  const payload = verifyApprovalToken(token);

  if (!payload) {
    return (
      <Shell>
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
          Summer check-in
        </p>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
          This link is no longer valid
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          The approval link has expired or was malformed. Open the most recent check-in email for
          this student, or grant a meeting from the developer dashboard.
        </p>
      </Shell>
    );
  }

  const copy = ACTION_COPY[payload.action];

  return (
    <Shell>
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        Summer check-in · meeting decision
      </p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">{copy.title}</h1>
      <p className="mt-3 text-sm text-ink-soft">
        Student: <span className="font-semibold text-ink">{payload.studentName}</span>
      </p>
      <p className="mt-1 text-sm leading-relaxed text-ink-soft">
        {payload.action === 'reject'
          ? 'A written report will be generated and no email is sent to the student.'
          : 'The student will be emailed a booking link (parents CC’d) and can pick a time.'}
      </p>

      <div className="mt-6">
        <ApprovalConfirm
          token={token}
          studentName={payload.studentName}
          verb={copy.verb}
          tone={copy.tone}
        />
      </div>
    </Shell>
  );
}
