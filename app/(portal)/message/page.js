import { MessageSquare } from 'lucide-react';
import TabPlaceholder from '../TabPlaceholder';

export default function MessagePage() {
  return (
    <TabPlaceholder
      icon={MessageSquare}
      stage="Stage 5"
      title="Message"
      blurb="A quick note to Aaron or Ryan — routes to support@admissions.partners with your name attached."
    />
  );
}
