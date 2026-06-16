'use client';

import { Suspense } from 'react';
import WriteApp from './WriteApp';

export default function WritePage() {
  return (
    <Suspense
      fallback={
        <div className="relative z-10 mx-auto w-full max-w-3xl px-5 py-8">
          <div className="portal-skeleton h-12 w-full rounded-full" />
          <div className="portal-skeleton mt-4 h-[70vh] w-full rounded-[2.25rem]" />
        </div>
      }
    >
      <WriteApp />
    </Suspense>
  );
}
