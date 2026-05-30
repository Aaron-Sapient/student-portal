import { ListTodo } from 'lucide-react';
import TabPlaceholder from '../TabPlaceholder';

export default function DeadlinesPage() {
  return (
    <TabPlaceholder
      icon={ListTodo}
      stage="Stage 4"
      title="Deadlines & Projects"
      blurb="Your projects and college-app dates, grouped by urgency. Pulls from your own sheet."
    />
  );
}
