'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDevData } from '@/app/developer/(panel)/DevDataContext';
import { Badge, Card, Chip, EmptyNote, ErrorNote, PageHeader, TabSkeleton } from '@/app/developer/(panel)/devUi';
import { formatDateOnly } from '@/app/developer/(panel)/devFormat';

// Read-only view of the summer group-project census (student-facing
// /project-report). Raw intake only — the fuzzy team-name/roster
// reconciliation is a separate offline Claude pass, not this view. This is
// the only place the data is surfaced; students only ever write it.

const FILTERS = [
  ['all', 'All'],
  ['needsRoster', 'Needs roster'],
  ['inProject', 'On a project'],
  ['noProject', 'No project'],
  ['notReported', 'Not reported'],
];

function ProjectRow({ p }) {
  return (
    <div className="border-t border-sand py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-semibold text-ink">{p.projectName || 'Untitled project'}</p>
        <Badge tone={p.response === 'not_finalized' ? 'ochre' : 'moss'}>
          {p.response === 'not_finalized' ? 'Needs roster' : 'Finalized'}
        </Badge>
      </div>
      {p.response === 'not_finalized' ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
          Roster not finalized — student was told to email Ryan directly.
        </p>
      ) : (
        <div className="mt-1 space-y-1 text-[12px] leading-relaxed text-ink-soft">
          {p.projectPlan && <p>{p.projectPlan}</p>}
          {p.teamMembers && <p className="whitespace-pre-line"><span className="font-semibold text-ink-faint">Team: </span>{p.teamMembers}</p>}
          {p.timeline && <p><span className="font-semibold text-ink-faint">Timeline: </span>{p.timeline}</p>}
          {p.preferredTime && <p><span className="font-semibold text-ink-faint">Preferred check-in time: </span>{p.preferredTime}</p>}
        </div>
      )}
    </div>
  );
}

function StudentCard({ student, delay }) {
  return (
    <Card delay={delay} className="mb-4">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-[15px] font-semibold text-ink">{student.name}</h3>
        <div className="flex items-center gap-2">
          {student.grade && <Badge tone="muted">{student.grade}</Badge>}
          {student.updatedAt && (
            <span className="text-[11px] font-medium text-ink-faint">
              {formatDateOnly(student.updatedAt)}
            </span>
          )}
        </div>
      </div>
      {student.status === 'no_project' ? (
        <EmptyNote>Reported: not on a group project.</EmptyNote>
      ) : (
        <div>
          {student.projects.map((p) => (
            <ProjectRow key={p.index} p={p} />
          ))}
        </div>
      )}
    </Card>
  );
}

export default function ProjectsTab() {
  const { projectReports, ensure, refresh } = useDevData();
  useEffect(() => ensure('projectReports'), [ensure]);

  const [filter, setFilter] = useState('all');

  const payload = projectReports.data;
  const reported = useMemo(() => payload?.reported || [], [payload]);
  const notReported = useMemo(() => payload?.notReported || [], [payload]);

  const counts = useMemo(
    () => ({
      needsRoster: reported.filter((s) => s.needsRoster).length,
      inProject: reported.filter((s) => s.status === 'in_project').length,
      noProject: reported.filter((s) => s.status === 'no_project').length,
      notReported: notReported.length,
    }),
    [reported, notReported]
  );

  const visibleStudents = useMemo(() => {
    switch (filter) {
      case 'needsRoster':
        return reported.filter((s) => s.needsRoster);
      case 'inProject':
        return reported.filter((s) => s.status === 'in_project');
      case 'noProject':
        return reported.filter((s) => s.status === 'no_project');
      default:
        return reported;
    }
  }, [reported, filter]);

  return (
    <div>
      <PageHeader eyebrow="Summer census" title="Projects">
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-soft">
          Who reported into the group-project census, what they&apos;re building, and who
          still needs to. Reconciling messy team names is a separate offline pass —
          this is the raw intake as students submitted it.
        </p>
      </PageHeader>

      {projectReports.error ? (
        <ErrorNote message={projectReports.error} onRetry={() => refresh('projectReports')} />
      ) : !projectReports.loaded ? (
        <TabSkeleton rows={5} />
      ) : (
        <>
          <div className="portal-rise mb-5 flex flex-wrap gap-x-8 gap-y-3" style={{ animationDelay: '60ms' }}>
            {[
              ['Needs roster', counts.needsRoster],
              ['On a project', counts.inProject],
              ['No project', counts.noProject],
              ['Not reported', counts.notReported],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="font-display text-2xl font-semibold leading-none text-ink">{value}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {label}
                </p>
              </div>
            ))}
          </div>

          <div className="portal-rise mb-5 flex flex-wrap gap-2" style={{ animationDelay: '110ms' }}>
            {FILTERS.map(([key, label]) => (
              <Chip key={key} on={filter === key} onClick={() => setFilter(key)}>
                {label}
              </Chip>
            ))}
          </div>

          {filter === 'notReported' ? (
            notReported.length === 0 ? (
              <Card delay={150}>
                <EmptyNote>Everyone on the roster has reported in.</EmptyNote>
              </Card>
            ) : (
              <Card delay={150}>
                <div className="flex flex-wrap gap-2">
                  {notReported.map((s) => (
                    <span
                      key={s.sheetId}
                      className="neu-chip rounded-full px-3.5 py-1.5 text-[12px] font-semibold text-ink-soft"
                    >
                      {s.name}
                      {s.grade ? ` · ${s.grade}` : ''}
                    </span>
                  ))}
                </div>
              </Card>
            )
          ) : visibleStudents.length === 0 ? (
            <Card delay={150}>
              <EmptyNote>No students match this filter.</EmptyNote>
            </Card>
          ) : (
            visibleStudents.map((s, i) => <StudentCard key={s.sheetId} student={s} delay={150 + i * 20} />)
          )}
        </>
      )}
    </div>
  );
}
