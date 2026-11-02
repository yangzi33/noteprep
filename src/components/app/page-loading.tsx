/** Shown by a route's loading.tsx while its server data loads; announced to screen readers as a status. */
export function PageLoading({ label }: { label: string }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
      <p role="status" className="text-sm text-muted-foreground">
        {label}
      </p>
    </main>
  );
}
