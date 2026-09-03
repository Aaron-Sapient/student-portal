'use client';

import { useState } from 'react';
import {
  BookOpen,
  CalendarClock,
  CheckCircle2,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
} from 'lucide-react';
import WeekFeel from '@/app/(portal)/check-ins/WeekFeel';
import TaskTrough from '@/app/(portal)/check-ins/TaskTrough';

/* The weekly check-in, as the student actually meets it.

   WeekFeel and TaskTrough are IMPORTED, not rebuilt: they are the product's own
   controls, so the clay slider a family drags here is the one their child drags
   on a Sunday night. StepHeader, Segment and fieldCls are copied verbatim from
   app/(portal)/check-ins/RyanCheckIn.js:53-92 because that file does not export
   them -- the product itself keeps three private copies (RyanCheckIn,
   AaronCheckIn, SeniorCheckIn), so a fourth is the existing convention rather
   than a new one.

   Steps, eyebrows, titles, blurbs, placeholders and option sets are the shipped
   strings. What is NOT here is the submit: the real form POSTs to
   /api/submitUpdateForm, where Claude reads the answers and decides whether the
   week earns a meeting. This demo has no server and must never look like it
   made a judgement, so the last step hands off to booking without claiming an
   evaluation happened.

   Why it is a modal and not a tab. A check-in is a prerequisite for booking,
   and a prerequisite that lives at its own address is a place a student can be
   sent and then lost. As a modal it is the doorway to the thing it gates. */

const GRADE_OPTIONS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F'];
const CONCERN_OPTIONS = ['None', 'Quick Question', 'Need to Discuss'];

function StepHeader({ icon: Icon, eyebrow, title, blurb }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-3">
        <span className="neu-chip flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-terracotta">
          <Icon className="h-5 w-5" strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
            {eyebrow}
          </p>
          <h2 className="font-display text-[1.7rem] font-semibold leading-tight tracking-tight text-ink">
            {title}
          </h2>
        </div>
      </div>
      {blurb && <p className="mt-2 pl-[3.75rem] text-sm leading-relaxed text-ink-soft">{blurb}</p>}
    </div>
  );
}

function Segment({ active, onClick, children, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-2.5 text-center text-[13px] font-semibold transition-all duration-150 active:scale-[0.97] ${
        active ? 'bg-terracotta text-paper shadow-sm' : 'neu-chip text-ink-soft hover:text-ink'
      } ${className}`}
    >
      {children}
    </button>
  );
}

const fieldCls =
  'neu-inset w-full rounded-2xl px-4 py-3 text-[15px] text-ink outline-none transition placeholder:text-ink-faint focus:ring-2 focus:ring-terracotta/25';

const STEPS = ['week', 'grades', 'tests', 'tasks', 'concerns'];

export default function CheckInModal({ courses = [], onComplete }) {
  const [step, setStep] = useState(0);
  // WeekFeel is a 0-100 control, not 0-1 (feelToRating divides by 10 to reach
  // the backend's 1-10 scale). 62 opens the clay at a decent-but-not-perfect
  // week, which is the honest place for a demo to start.
  const [feel, setFeel] = useState(62);
  const [grades, setGrades] = useState(() => courses.map((c) => c.grade || ''));
  const [gradeOpen, setGradeOpen] = useState(null);
  const [tests, setTests] = useState('');
  const [tasks, setTasks] = useState([
    { task: '', status: 'partly' },
    { task: '', status: 'partly' },
  ]);
  const [concern, setConcern] = useState('None');
  const [concernText, setConcernText] = useState('');

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="pb-2">
      <div className="mb-6">
        <div className="flex items-baseline justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-faint">
            Weekly check-in
          </p>
          <p className="text-[11px] font-semibold tabular-nums text-ink-faint">
            {step + 1} / {STEPS.length}
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sand/60">
          <div
            className="h-full rounded-full bg-terracotta transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div key={current} className="neu-raised relative overflow-hidden rounded-3xl p-6 sm:p-7">
        {current === 'week' && (
          <>
            <StepHeader
              icon={Sparkles}
              eyebrow="Self-evaluation"
              title="How’d the week go?"
              blurb="Slide the clay to where the week landed."
            />
            <WeekFeel value={feel} onChange={setFeel} />
          </>
        )}

        {current === 'grades' && (
          <>
            <StepHeader
              icon={BookOpen}
              eyebrow="Fall semester"
              title="Current grades"
              blurb="Tap a class to set where it stands right now."
            />
            <div className="divide-y divide-sand/70">
              {courses.map((c, i) => (
                <div key={c.id} className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{c.name}</span>
                    <button
                      type="button"
                      onClick={() => setGradeOpen(gradeOpen === i ? null : i)}
                      className={`min-w-[3.25rem] rounded-full px-3.5 py-1.5 text-sm font-bold transition ${
                        grades[i] ? 'bg-terracotta text-paper' : 'neu-chip text-ink-soft'
                      }`}
                    >
                      {grades[i] || '·'}
                    </button>
                  </div>
                  {gradeOpen === i && (
                    <div className="mt-3 grid grid-cols-7 gap-1.5">
                      {GRADE_OPTIONS.map((g) => (
                        <Segment
                          key={g}
                          active={grades[i] === g}
                          onClick={() => {
                            setGrades((p) => p.map((x, j) => (j === i ? g : x)));
                            setGradeOpen(null);
                          }}
                          className="!px-1 !py-1.5 !text-[12px]"
                        >
                          {g}
                        </Segment>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {current === 'tests' && (
          <>
            <StepHeader
              icon={CalendarClock}
              eyebrow="This week & next"
              title="Tests & deadlines"
              blurb="List any tests, projects, or major assignments coming up — with dates."
            />
            <textarea
              value={tests}
              onChange={(e) => setTests(e.target.value)}
              rows={5}
              placeholder="e.g. AP Bio unit test Thu · College essay draft due Mon"
              className={`${fieldCls} resize-none leading-relaxed`}
            />
          </>
        )}

        {current === 'tasks' && (
          <>
            <StepHeader
              icon={ListTodo}
              eyebrow="Last week"
              title="Task updates"
              blurb="Add 1–3 counseling tasks and mark where each stands."
            />
            <div className="space-y-4">
              {tasks.map((item, i) => (
                <div key={i} className="neu-inset rounded-2xl p-3">
                  <input
                    type="text"
                    value={item.task}
                    onChange={(e) =>
                      setTasks((p) =>
                        p.map((x, j) => (j === i ? { ...x, task: e.target.value } : x))
                      )
                    }
                    placeholder={`Task ${i + 1}`}
                    className="w-full bg-transparent px-1 py-1 text-[15px] text-ink outline-none placeholder:text-ink-faint"
                  />
                  <div className="mt-2.5">
                    <TaskTrough
                      value={item.status}
                      onChange={(s) =>
                        setTasks((p) => p.map((x, j) => (j === i ? { ...x, status: s } : x)))
                      }
                    />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {current === 'concerns' && (
          <>
            <StepHeader
              icon={MessageCircleQuestion}
              eyebrow="For your team"
              title="Questions or concerns"
              blurb="Anything you want us to know about this week?"
            />
            <div className="grid grid-cols-3 gap-1.5">
              {CONCERN_OPTIONS.map((opt) => (
                <Segment
                  key={opt}
                  active={concern === opt}
                  onClick={() => {
                    setConcern(opt);
                    if (opt === 'None') setConcernText('');
                  }}
                  className="!px-1 !text-[12px]"
                >
                  {opt}
                </Segment>
              ))}
            </div>
            {concern !== 'None' && (
              <textarea
                value={concernText}
                onChange={(e) => setConcernText(e.target.value)}
                rows={4}
                placeholder="What’s on your mind?"
                className={`${fieldCls} mt-4 resize-none leading-relaxed`}
              />
            )}
          </>
        )}
      </div>

      {/* Pinned to the bottom of the modal's scroll area. The clay slider makes
          step 1 taller than a 1080 screen has room for, and a Next button that
          falls below the fold is a demo that looks like it has no next step. */}
      <div className="demo-checkin-foot mt-6 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-full px-4 py-2.5 text-[14px] font-semibold text-ink-soft transition disabled:opacity-0"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => (isLast ? onComplete?.() : setStep((s) => s + 1))}
          className="inline-flex items-center gap-2 rounded-full bg-terracotta px-6 py-3 text-[15px] font-semibold text-paper transition active:scale-[0.98]"
        >
          {isLast ? (
            <>
              <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />
              Submit and book
            </>
          ) : (
            'Next'
          )}
        </button>
      </div>
    </div>
  );
}
