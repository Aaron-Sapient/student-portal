import { CalendarDays } from 'lucide-react';
import TabPlaceholder from '../TabPlaceholder';

export default function BookPage() {
  return (
    <TabPlaceholder
      icon={CalendarDays}
      stage="Stage 3"
      title="Book a Meeting"
      blurb="A 3-step mobile flow — pick instructor, day, then slot — will live here."
      legacyHref="/booking"
    />
  );
}
