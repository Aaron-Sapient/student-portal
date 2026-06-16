'use client';

import { Suspense } from 'react';
import EditorView from './EditorView';

export default function EditPage() {
  return (
    <Suspense
      fallback={
        <div className="relative z-10 flex h-[100dvh] items-center justify-center">
          <div className="portal-skeleton h-40 w-full max-w-3xl rounded-3xl" />
        </div>
      }
    >
      <EditorView />
    </Suspense>
  );
}
