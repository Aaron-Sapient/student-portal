'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BookPlus } from 'lucide-react';
import { CalendarClock } from 'lucide-react';
import { ListTodo } from 'lucide-react';
import { FileQuestionMark } from 'lucide-react';
import { Sparkle } from 'lucide-react';


const GRADE_OPTIONS = ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'];
const STATUS_OPTIONS = ['Completed', 'In Progress', 'Not Started'];
const CONCERN_OPTIONS = ['None', 'Quick Question', 'Need to Discuss'];
const RESPONSE_OPTIONS = ['No preference', 'Written report', '15-min call', '30-min Zoom'];
const ACADEMIC_RATINGS = [1,2,3,4,5,6,7,8,9,10];

function getMostRecentMonday() {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - diff);
  return monday;
}

function isFormStillValid(lastSubmitted) {
  if (!lastSubmitted) return false;
  return new Date(lastSubmitted) >= getMostRecentMonday();
}

const semesterLabel = s => s === 'S1' ? 'Fall' : 'Spring';

export default function UpdateForm({ onFormComplete }) {
  const router = useRouter();
  const [status, setStatus] = useState('loading');
  const [formData, setFormData] = useState(null);
  const [step, setStep] = useState(0);
  const [routingResult, setRoutingResult] = useState(null); // { decision, reason }

  // Q1
  const [grades, setGrades] = useState({});
  const [openDropdown, setOpenDropdown] = useState(null);

  // Q2
  const [testsAndDeadlines, setTestsAndDeadlines] = useState('');

  // Q3
  const [actionItems, setActionItems] = useState([
    { task: '', status: null },
    { task: '', status: null },
    { task: '', status: null },
  ]);

  // Q4
  const [concernCategory, setConcernCategory] = useState('None');
  const [concernText, setConcernText] = useState('');

  // Q5
  const [academicRating, setAcademicRating] = useState(5);
  const [responsePreference, setResponsePreference] = useState(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { fetchFormData(); }, []);

  useEffect(() => {
    const handler = () => setOpenDropdown(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  async function fetchFormData() {
    try {
      const res = await fetch('/api/getUpdateFormData');
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (isFormStillValid(data.lastSubmitted)) {
        setStatus('done');
        onFormComplete?.();
        return;
      }

      if (!data.skip) {
        const initialGrades = {};
        data.classes.forEach((cls, i) => { initialGrades[i] = cls.grade || ''; });
        setGrades(initialGrades);
      }

      setFormData(data);
      setStatus('needed');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  async function handleSubmit() {
    if (!actionItems.some(x => x.task.trim())) {
      setError('Please enter at least one task in the Task Updates section.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const gradePayload = (formData?.classes || []).map((cls, i) => ({
        rowOffset: cls.rowOffset,
        grade: grades[i] || '',
      }));

      const filledItems = actionItems.filter(x => x.task.trim());

      const res = await fetch('/api/submitUpdateForm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grades: gradePayload,
          classes: formData?.classes || [],
          studentSheetId: formData?.studentSheetId,
          gradesRange: formData?.gradesRange,
          studentRowIndex: formData?.studentRowIndex,
          studentName: formData?.studentName,
          testsAndDeadlines,
          actionItemStatuses: filledItems.map(x => ({
            task: x.task,
            status: x.status || 'Not Started',
          })),
          questionsCategory: concernCategory,
          questionsText: concernCategory !== 'None' ? concernText : '',
          selfRating: academicRating,
          responsePreference: responsePreference || '',
        }),
      });

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Submission failed');

      // Handle AI routing decision
      if (result.decision === 'written') {
        setRoutingResult({ decision: 'written', reason: result.reason });
        setStatus('routed');
      } else {
        // Navigate to booking page with meeting type
        router.push(`/booking?type=${result.decision === '15min' ? '15' : '30'}`);
      }

    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  // ── Early returns ──────────────────────────────────────────────────────────

  if (status === 'loading') return (
    <div style={styles.loadingWrap}>
      <div style={styles.loadingDot} />
      <span style={styles.loadingText}>Loading your check-in…</span>
    </div>
  );

  if (status === 'error') return (
    <div style={styles.errorWrap}>Something went wrong: {error}</div>
  );

  if (status === 'routed') return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
          <span style={styles.iconFallback}>✉️</span>
        </div>
        <div>
          <h2 style={styles.title}>You're all set!</h2>
          <p style={styles.subtitle}>Ryan will send you a written update soon.</p>
        </div>
      </div>
      {routingResult?.reason && (
        <p style={{ fontSize: '0.9rem', color: '#888', marginTop: '0.5rem', fontFamily: "'DM Sans', 'Poppins', sans-serif" }}>
          {routingResult.reason}
        </p>
      )}
    </div>
  );

if (status === 'done') return null;

  if (status === 'needed' && !formData) return (
    <div style={styles.loadingWrap}>
      <div style={styles.loadingDot} />
      <span style={styles.loadingText}>Loading your check-in…</span>
    </div>
  );

  // ── Step definitions ───────────────────────────────────────────────────────

  const showQ1 = formData?.semester !== 'NA'
    && formData?.gradeYear !== 'MS'
    && formData?.classes?.length > 0;

  const steps = [
    ...(showQ1 ? ['grades'] : []),
    'tests',
    'tasks',
    'concerns',
    'evaluation',
  ];

  const currentStep = steps[step];
  const isFirst = step === 0;
  const isLast = step === steps.length - 1;

  function handleNext() {
    if (isLast) {
      handleSubmit();
    } else {
      setError(null);
      setStep(s => s + 1);
    }
  }

  function handleBack() {
    setError(null);
    setStep(s => s - 1);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{cssString}</style>

      <div style={styles.card}>

        {/* Q1: Grades Update */}
        {currentStep === 'grades' && (
          <>
            <div style={styles.header}>
              <div style={styles.iconBox}>
               <BookPlus className="w-15 h-15 text-gray-700 mt-1" strokeWidth={0.8} />
              </div>
              <div>
                <h2 style={styles.title}>Grades Update</h2>
                <p style={styles.subtitle}>
                  {formData?.gradeYear} &ndash; {semesterLabel(formData?.semester)}
                </p>
              </div>
            </div>

       <div style={{ ...styles.tableHeader, justifyContent: 'flex-start' }}>
  {/* flex: 1 pushes the next span to the right */}
  <span style={{ ...styles.colLabel, flex: 1, textAlign: 'left' }}>
    Class
  </span>
<span style={{ 
    ...styles.colLabel, 
    textAlign: 'left', 
    minWidth: '64px',
    paddingLeft: '0.3rem' // <--- Add this to match the pill's internal padding
  }}>
    Grade
  </span>
</div>

            {formData?.classes.map((cls, i) => (
            <div key={i} style={styles.row}>
  {/* Match the flex: 1 here */}
  <span style={{ ...styles.className, flex: 1, textAlign: 'left' }}>
    {cls.name}
  </span>
                <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
                  <button
                    className="grade-pill"
                    style={{
                      ...styles.pill,
                      backgroundColor: openDropdown === `g${i}` ? '#d8d7ce' : '#efede2',
                    }}
                    onClick={() => setOpenDropdown(openDropdown === `g${i}` ? null : `g${i}`)}
                  >
                    {grades[i] || '—'}
                  </button>
                  {openDropdown === `g${i}` && (
                    <div style={styles.dropdown}>
                      {GRADE_OPTIONS.map(g => (
                        <div
                          key={g}
                          className="dropdown-item"
                          style={{
                            ...styles.dropdownItem,
                            fontWeight: grades[i] === g ? '700' : '400',
                            backgroundColor: grades[i] === g ? '#efede2' : 'transparent',
                          }}
                          onClick={() => {
                            setGrades(prev => ({ ...prev, [i]: g }));
                            setOpenDropdown(null);
                          }}
                        >
                          {g}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div style={{ height: `${Math.max(12, 48 - (formData?.classes.length || 0) * 4)}px` }} />
          </>
        )}

        {/* Q2: Tests & Deadlines */}
        {currentStep === 'tests' && (
          <>
            <div style={styles.header}>
              <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
               <CalendarClock className="w-15 h-15 text-gray-700 -mt-3" strokeWidth={0.8} />
              </div>
              <div>
                <h2 style={styles.title}>Tests & Deadlines</h2>
                <p style={styles.subtitle}>
                  Please list any tests, projects, or major assignments due this week or next.
                </p>
              </div>
            </div>

            <textarea
              value={testsAndDeadlines}
              onChange={e => setTestsAndDeadlines(e.target.value)}
              placeholder="Include dates for school and counseling tasks."
              style={styles.textarea}
              rows={4}
            />
            <div style={{ height: '1rem' }} />
          </>
        )}

        {/* Q3: Task Updates */}
        {currentStep === 'tasks' && (
          <>
            <div style={styles.header}>
              <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
                <ListTodo className="w-15 h-15 text-gray-700 -mt-3" strokeWidth={0.8} />
              </div>
              <div>
                <h2 style={styles.title}>Task Updates</h2>
                <p style={styles.subtitle}>
                  Please list <strong>1–3 counseling tasks</strong> from last week and indicate their <strong>status</strong>.
                </p>
              </div>
            </div>

            <div style={styles.tableHeader}>
              <span style={styles.colLabel}>Task</span>
              <span style={{ ...styles.colLabel, position: 'relative', right: '30px' }}>Status</span>
            </div>

            {actionItems.map((item, i) => (
              <div key={i} style={styles.row}>
                <input
                  type="text"
                  value={item.task}
                  onChange={e => setActionItems(prev =>
                    prev.map((x, j) => j === i ? { ...x, task: e.target.value } : x)
                  )}
                  placeholder="Task name"
                  style={styles.taskInput}
                />
                <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
                  <button
                    className="grade-pill"
                    style={{
                      ...styles.pill,
                      backgroundColor: openDropdown === `s${i}` ? '#d8d7ce' : '#efede2',
                      minWidth: '110px',
                      color: item.status === null ? '#aaa' : 'var(--form-text, #111)',
                      fontWeight: item.status === null ? '400' : '600',
                    }}
                    onClick={() => setOpenDropdown(openDropdown === `s${i}` ? null : `s${i}`)}
                  >
                    {item.status === null ? 'Select' : item.status}
                  </button>
                  {openDropdown === `s${i}` && (
                    <div style={{ ...styles.dropdown, gridTemplateColumns: '1fr', minWidth: '140px' }}>
                      {STATUS_OPTIONS.map(s => (
                        <div
                          key={s}
                          className="dropdown-item"
                          style={{
                            ...styles.dropdownItem,
                            fontWeight: item.status === s ? '700' : '400',
                            backgroundColor: item.status === s ? '#efede2' : 'transparent',
                          }}
                          onClick={() => {
                            setActionItems(prev =>
                              prev.map((x, j) => j === i ? { ...x, status: s } : x)
                            );
                            setOpenDropdown(null);
                          }}
                        >
                          {s}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div style={{ height: '12px' }} />
          </>
        )}

        {/* Q4: Questions / Concerns */}
        {currentStep === 'concerns' && (
          <>
            <div style={styles.header}>
              <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
               <FileQuestionMark className="w-15 h-15 text-gray-700 mt-1" strokeWidth={0.8} />
              </div>
              <div>
                <h2 style={styles.title}>Questions/Concerns</h2>
                <p style={styles.subtitle}>This helps us better assist you.</p>
              </div>
            </div>

            <div style={styles.concernRow}>
              <span style={styles.concernLabel}>Please select an option:</span>
              <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
                <button
                  className="grade-pill"
                  style={{
                    ...styles.pill,
                    backgroundColor: openDropdown === 'concern' ? '#d8d7ce' : '#efede2',
                    minWidth: '160px',
                  }}
                  onClick={() => setOpenDropdown(openDropdown === 'concern' ? null : 'concern')}
                >
                  {concernCategory}
                </button>
                {openDropdown === 'concern' && (
                  <div style={{ ...styles.dropdown, gridTemplateColumns: '1fr', minWidth: '180px' }}>
                    {CONCERN_OPTIONS.map(opt => (
                      <div
                        key={opt}
                        className="dropdown-item"
                        style={{
                          ...styles.dropdownItem,
                          fontWeight: concernCategory === opt ? '700' : '400',
                          backgroundColor: concernCategory === opt ? '#efede2' : 'transparent',
                        }}
                        onClick={() => {
                          setConcernCategory(opt);
                          if (opt === 'None') setConcernText('');
                          setOpenDropdown(null);
                        }}
                      >
                        {opt}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {concernCategory !== 'None' && (
              <div style={{ marginTop: '1.25rem' }}>
                <textarea
                  value={concernText}
                  onChange={e => setConcernText(e.target.value)}
                  placeholder="Describe your question or concern"
                  style={styles.textarea}
                  rows={4}
                />
              </div>
            )}

            <div style={{ height: '1rem' }} />
          </>
        )}

        {/* Q5: Self-Evaluation */}
        {currentStep === 'evaluation' && (
          <>
            <div style={styles.header}>
              <div style={{ ...styles.iconBox, backgroundColor: 'transparent' }}>
                   <Sparkle className="w-15 h-15 text-gray-700" strokeWidth={0.9} />
              </div>
              <div>
                <h2 style={styles.title}>Self-Evaluation</h2>
              </div>
            </div>

            <div style={styles.evalSection}>
              <span style={styles.evalCategory}>Academics</span>
              <div style={styles.evalRow}>
                <p style={styles.evalQuestion}>
                  On a scale of <strong>1–10</strong>, how do you feel about your academic progress for this week?
                </p>
                <div style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <button
                    className="grade-pill"
                    style={{
                      ...styles.pill,
                      backgroundColor: openDropdown === 'rating' ? '#d8d7ce' : '#efede2',
                      minWidth: '72px',
                    }}
                    onClick={() => setOpenDropdown(openDropdown === 'rating' ? null : 'rating')}
                  >
                    {academicRating}
                  </button>
                  {openDropdown === 'rating' && (
                    <div style={{ ...styles.dropdown, gridTemplateColumns: 'repeat(2, 1fr)', minWidth: '100px' }}>
                      {ACADEMIC_RATINGS.map(n => (
                        <div
                          key={n}
                          className="dropdown-item"
                          style={{
                            ...styles.dropdownItem,
                            fontWeight: academicRating === n ? '700' : '400',
                            backgroundColor: academicRating === n ? '#efede2' : 'transparent',
                          }}
                          onClick={() => {
                            setAcademicRating(n);
                            setOpenDropdown(null);
                          }}
                        >
                          {n}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={styles.evalDivider} />

            <div style={styles.evalSection}>
              <span style={styles.evalCategory}>Preferred Response Type</span>
              <div style={styles.evalRow}>
                <p style={styles.evalQuestion}>
                  Based on your answers, please indicate your preferred response type.
                </p>
                <div style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <button
                    className="grade-pill"
                    style={{
                      ...styles.pill,
                      backgroundColor: openDropdown === 'response' ? '#d8d7ce' : '#efede2',
                      minWidth: '140px',
                      color: responsePreference === null ? '#aaa' : 'var(--form-text, #111)',
                      fontWeight: responsePreference === null ? '400' : '600',
                    }}
                    onClick={() => setOpenDropdown(openDropdown === 'response' ? null : 'response')}
                  >
                    {responsePreference === null ? 'Select' : responsePreference}
                  </button>
                  {openDropdown === 'response' && (
                    <div style={{ ...styles.dropdown, gridTemplateColumns: '1fr', minWidth: '180px' }}>
                      {RESPONSE_OPTIONS.map(opt => (
                        <div
                          key={opt}
                          className="dropdown-item"
                          style={{
                            ...styles.dropdownItem,
                            fontWeight: responsePreference === opt ? '700' : '400',
                            backgroundColor: responsePreference === opt ? '#efede2' : 'transparent',
                          }}
                          onClick={() => {
                            setResponsePreference(opt);
                            setOpenDropdown(null);
                          }}
                        >
                          {opt}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ height: '0.5rem' }} />
          </>
        )}

        {/* Submitting overlay message */}
        {submitting && (
          <div style={styles.analyzingWrap}>
            <div style={styles.loadingDot} />
            <span style={styles.loadingText}>Analyzing your check-in…</span>
          </div>
        )}

        {/* Error */}
        {error && <p style={styles.errorInline}>{error}</p>}

        {/* Navigation pills */}
        {!submitting && (
          <div style={styles.navRow}>
            {!isFirst && (
              <button className="nav-pill-back" style={styles.navPillBack} onClick={handleBack}>
                ← Back
              </button>
            )}
            <button
              className="nav-pill-next"
              style={{ ...styles.navPillNext, marginLeft: 'auto' }}
              onClick={handleNext}
              disabled={submitting}
            >
              {isLast ? 'Submit ↑' : 'Next →'}
            </button>
          </div>
        )}

      </div>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  card: {
    backgroundColor: 'var(--form-bg, #FAF9F4)',
    border: '1px solid var(--form-border, #B4B3B0)',
    borderRadius: '20px',
    padding: '2rem 2.5rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    maxWidth: '640px',
    margin: '0 auto 1.25rem',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    marginBottom: '2rem',
  },
  iconBox: {
    width: '72px',
    height: '72px',
    borderRadius: '16px',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    flexShrink: 0,
    fontSize: '2rem',
  },
  iconFallback: {
    fontSize: '2rem',
    lineHeight: 1,
  },
  title: {
    margin: 0,
    marginLeft: '-4px',
    fontSize: '2rem',
    fontWeight: '700',
    color: 'var(--form-text, #111)',
    letterSpacing: '-0.02em',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  subtitle: {
    margin: '0.2rem 0 0',
    fontSize: '1rem',
    color: 'var(--form-text-muted, #555)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  tableHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    paddingBottom: '0.75rem',
    borderBottom: '1px solid var(--form-border, #B4B3B0)',
    marginBottom: '0.25rem',
  },
  colLabel: {
    fontSize: '1.05rem',
    fontWeight: '700',
    color: 'var(--form-text, #111)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.85rem 0',
    borderBottom: '1px solid var(--form-border, #B4B3B0)',
  },
  className: {
    fontSize: '0.95rem',
    color: 'var(--form-text, #111)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  taskInput: {
    width: '55%',
    padding: '0.5rem 0.85rem',
    border: '1px solid white',
    borderRadius: '10px',
    backgroundColor: '#fffef8',
    boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: 'var(--form-text, #111)',
    outline: 'none',
  },
  pill: {
    border: '1px solid var(--form-border, #B4B3B0)',
    borderRadius: '999px',
    padding: '0.35rem 1.1rem',
    fontSize: '0.9rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: 'var(--form-text, #111)',
    transition: 'background-color 0.15s ease',
    minWidth: '64px',
    textAlign: 'center',
  },
  dropdown: {
    position: 'absolute',
    right: 0,
    top: 'calc(100% + 6px)',
    backgroundColor: 'var(--form-bg, #FAF9F4)',
    border: '1px solid var(--form-border, #B4B3B0)',
    borderRadius: '12px',
    padding: '0.4rem',
    zIndex: 100,
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '2px',
    minWidth: '140px',
  },
  dropdownItem: {
    padding: '0.4rem 0.5rem',
    borderRadius: '8px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    textAlign: 'center',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: 'var(--form-text, #111)',
    transition: 'background-color 0.1s ease',
  },
  textarea: {
    width: '100%',
    padding: '1rem',
    border: '1px solid white',
    borderRadius: '12px',
    backgroundColor: '#fffef8',
    boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    fontSize: '0.95rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    color: 'var(--form-text, #111)',
    resize: 'none',
    outline: 'none',
    boxSizing: 'border-box',
    lineHeight: '1.6',
  },
  concernRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '0.5rem',
  },
  concernLabel: {
    fontSize: '0.95rem',
    fontWeight: '700',
    color: 'var(--form-text, #111)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    whiteSpace: 'nowrap',
  },
  evalSection: {
    marginBottom: '0.25rem',
  },
  evalCategory: {
    display: 'block',
    fontSize: '0.85rem',
    fontWeight: '600',
    color: 'var(--form-text-muted, #888)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    marginBottom: '0.4rem',
    letterSpacing: '0.01em',
  },
  evalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1.5rem',
  },
  evalQuestion: {
    margin: 0,
    fontSize: '0.95rem',
    color: 'var(--form-text, #111)',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    lineHeight: '1.5',
    flex: 1,
  },
  evalDivider: {
    height: '1px',
    backgroundColor: 'var(--form-border, #B4B3B0)',
    margin: '1.25rem 0',
  },
  analyzingWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '1rem 0',
    color: '#888',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    marginTop: '1.5rem',
  },
  navPillBack: {
    backgroundColor: '#d8d6c8',
    color: '#2c2c2c',
    border: 'none',
    borderRadius: '999px',
    padding: '0.5rem 1.4rem',
    fontSize: '0.9rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  navPillNext: {
    backgroundColor: '#C6613F',
    color: 'white',
    border: 'none',
    borderRadius: '999px',
    padding: '0.5rem 1.4rem',
    fontSize: '0.9rem',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
    transition: 'opacity 0.15s ease',
  },
  loadingWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    padding: '1.5rem',
    color: '#888',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  loadingDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: '#B4B3B0',
    animation: 'pulse 1.2s ease-in-out infinite',
    flexShrink: 0,
  },
  loadingText: {
    fontSize: '0.9rem',
  },
  errorWrap: {
    padding: '1rem',
    color: '#c0392b',
    fontSize: '0.9rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  errorInline: {
    color: '#c0392b',
    fontSize: '0.85rem',
    margin: '0 0 0.5rem',
    fontFamily: "'DM Sans', 'Poppins', sans-serif",
  },
  devReset: {
    fontSize: '0.75rem',
    color: '#aaa',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
};

const cssString = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap');
  .grade-pill:hover { background-color: #d8d7ce !important; }
  .dropdown-item:hover { background-color: #efede2 !important; }
  .nav-pill-back:hover { opacity: 0.8; }
  .nav-pill-next:hover { opacity: 0.85; }
  .nav-pill-next:disabled { opacity: 0.5; cursor: not-allowed; }
  textarea::placeholder { color: #bbb; }
  textarea:focus { box-shadow: 0 1px 10px rgba(0,0,0,0.1); }
  input[type="text"]::placeholder { color: #bbb; }
  @keyframes pulse {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 1; }
  }
`;