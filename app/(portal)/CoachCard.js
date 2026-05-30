// A quiet, warm welcome note from Claude Coach — small and understated, not a
// centerpiece. No badges, no labels: just a gentle line that greets the student.
export default function CoachCard({ coach }) {
  if (!coach) return null;

  return (
    <section className="portal-rise" style={{ animationDelay: '40ms' }}>
      <div className="border-l-2 border-terracotta/40 pl-4">
        <p className="font-display text-[15px] font-normal leading-relaxed text-ink-soft">
          {coach.message}
        </p>
      </div>
    </section>
  );
}
