'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useDevData } from '../DevDataContext';
import {
  Badge,
  Card,
  Chip,
  EmptyNote,
  ErrorNote,
  GhostButton,
  PageHeader,
  PillButton,
  SearchInput,
  TabSkeleton,
} from '../devUi';
import { formatDateOnly } from '../devFormat';

const MAX_TEXTAREA_HEIGHT = 220;

function AutoResizingTextarea({ value, onChange, onBlur }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={2}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      className="neu-inset w-full resize-none overflow-auto rounded-xl bg-transparent p-2.5 text-[12px] leading-relaxed text-ink outline-none"
      style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
    />
  );
}

function ReportRow({ report, onPatch, onUpload, busy, busyMode }) {
  // Local state lets us debounce sheet writes to blur and avoid re-rendering the
  // textarea every keystroke from parent state. We sync from props on rowIndex change.
  const [local, setLocal] = useState({
    onTarget: report.onTarget,
    needsAttention: report.needsAttention,
    strategy: report.strategy,
    parentRequests: report.parentRequests,
  });

  useEffect(() => {
    setLocal({
      onTarget: report.onTarget,
      needsAttention: report.needsAttention,
      strategy: report.strategy,
      parentRequests: report.parentRequests,
    });
  }, [report.rowIndex, report.onTarget, report.needsAttention, report.strategy, report.parentRequests]);

  const cell = (field) => (
    <td className="p-1.5 align-top">
      <AutoResizingTextarea
        value={local[field]}
        onChange={(e) => setLocal((s) => ({ ...s, [field]: e.target.value }))}
        onBlur={() => {
          if (local[field] !== report[field]) onPatch(report.rowIndex, field, local[field]);
        }}
      />
    </td>
  );

  const primaryLabel =
    busy && busyMode === 'normal'
      ? report.status
        ? 'Re-uploading…'
        : 'Uploading…'
      : report.status
        ? 'Revise'
        : 'Upload';
  const silentLabel = busy && busyMode === 'silent' ? 'Sending…' : 'Silent';

  return (
    <tr className="border-b border-sand/60 last:border-0">
      <td className="whitespace-nowrap p-1.5 pt-3 align-top text-[12px] text-ink-soft">
        {formatDateOnly(report.date)}
      </td>
      <td className="whitespace-nowrap p-1.5 pt-3 align-top text-[13px] font-semibold text-ink">
        {report.student}
      </td>
      {cell('onTarget')}
      {cell('needsAttention')}
      {cell('strategy')}
      {cell('parentRequests')}
      <td className="whitespace-nowrap p-1.5 pt-3 text-center align-top">
        {report.parentNotified ? (
          <Badge tone="moss">Notified</Badge>
        ) : report.status ? (
          <Badge tone="ochre">Pending</Badge>
        ) : (
          <span className="text-[12px] text-ink-faint">—</span>
        )}
      </td>
      <td className="whitespace-nowrap p-1.5 align-top">
        <div className="flex flex-col items-stretch gap-1.5">
          <PillButton
            onClick={() => onUpload(report, { silent: false })}
            disabled={busy}
            className="!py-1.5"
          >
            {primaryLabel}
          </PillButton>
          <GhostButton
            onClick={() => onUpload(report, { silent: true })}
            disabled={busy}
            title="Upload to the student's sheet without emailing parents"
            className="!py-1 text-[11px]"
          >
            {silentLabel}
          </GhostButton>
        </div>
      </td>
    </tr>
  );
}

export default function ReportsTab() {
  const { reports, ensure, refresh } = useDevData();
  useEffect(() => ensure('reports'), [ensure]);

  const [busyRow, setBusyRow] = useState(null);
  const [busyMode, setBusyMode] = useState(null); // 'normal' | 'silent'
  const [unsentOnly, setUnsentOnly] = useState(false);
  const [search, setSearch] = useState('');

  const all = reports.data || [];

  const patch = async (rowIndex, field, value) => {
    try {
      const res = await fetch('/api/developer/writtenReports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex, field, value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert('Save failed: ' + (data.error || 'unknown'));
        refresh('reports'); // re-sync the textarea to the last saved value
      }
    } catch (err) {
      alert('Save failed: ' + err.message);
      refresh('reports');
    }
  };

  const upload = async (report, { silent = false } = {}) => {
    const verb = report.status ? 'Re-upload to' : 'Upload to';
    const suffix = silent ? ' WITHOUT emailing parents?' : '?';
    if (!confirm(`${verb} ${report.student}'s Google Sheet${suffix}`)) return;
    setBusyRow(report.rowIndex);
    setBusyMode(silent ? 'silent' : 'normal');
    try {
      const res = await fetch('/api/developer/writtenReports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowIndex: report.rowIndex, silent }),
      });
      const data = await res.json();
      if (!res.ok) alert('Upload failed: ' + (data.error || 'unknown'));
      await refresh('reports');
    } finally {
      setBusyRow(null);
      setBusyMode(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((r) => {
      if (unsentOnly && r.status) return false;
      if (q && !String(r.student).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [all, unsentOnly, search]);

  // Distinguish "unsent filter on AND zero unsent reports anywhere" (celebration)
  // from "filters knocked everything out for some other reason" (generic message).
  const allCaughtUp = unsentOnly && all.length > 0 && all.every((r) => r.status);

  return (
    <div>
      <PageHeader eyebrow="Parent deliverables" title="Reports" />

      <div className="portal-rise mb-5 flex flex-wrap items-center gap-3" style={{ animationDelay: '60ms' }}>
        <Chip on={unsentOnly} onClick={() => setUnsentOnly((v) => !v)}>
          Unsent only
        </Chip>
        <div className="ml-auto">
          <SearchInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search student…"
          />
        </div>
      </div>

      {reports.error ? (
        <ErrorNote message={reports.error} onRetry={() => refresh('reports')} />
      ) : !reports.loaded ? (
        <TabSkeleton rows={5} />
      ) : all.length === 0 ? (
        <Card delay={120}>
          <EmptyNote>No written reports yet.</EmptyNote>
        </Card>
      ) : allCaughtUp ? (
        <Card delay={120}>
          <div className="py-8 text-center">
            <img
              src="https://res.cloudinary.com/drgtneken/image/upload/v1778018446/empty_box_olfq9a.png"
              alt=""
              className="mx-auto block h-auto w-full max-w-[180px]"
            />
            <p className="mt-4 font-display text-[15px] font-semibold text-ink">
              No unsent reports. Great job!
            </p>
          </div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card delay={120}>
          <EmptyNote>No reports match the current filters.</EmptyNote>
        </Card>
      ) : (
        <Card delay={120}>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed border-collapse text-[13px]">
              <colgroup>
                <col style={{ width: 96 }} />
                <col style={{ width: 130 }} />
                <col />
                <col />
                <col />
                <col />
                <col style={{ width: 90 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-sand text-left">
                  {['Date', 'Student', 'On Target', 'Needs Attention', 'Strategy & Recs', 'Parent Requests'].map(
                    (h) => (
                      <th
                        key={h}
                        className="p-1.5 pb-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint"
                      >
                        {h}
                      </th>
                    )
                  )}
                  <th className="p-1.5 pb-2.5 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
                    Parents
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <ReportRow
                    key={r.rowIndex}
                    report={r}
                    onPatch={patch}
                    onUpload={upload}
                    busy={busyRow === r.rowIndex}
                    busyMode={busyRow === r.rowIndex ? busyMode : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
