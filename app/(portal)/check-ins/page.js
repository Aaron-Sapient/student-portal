import { ClipboardCheck } from 'lucide-react';
import TabPlaceholder from '../TabPlaceholder';

export default function CheckInsPage() {
  return (
    <TabPlaceholder
      icon={ClipboardCheck}
      stage="Stage 2"
      title="Check-Ins"
      blurb="Ryan, Aaron, and ART check-ins are moving into one place with clear “done this week” states."
      legacyHref="/dashboard"
    />
  );
}
