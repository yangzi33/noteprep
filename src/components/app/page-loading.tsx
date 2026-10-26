/** Loading state for signed-in routes: a calm centered spinner inside the layout shell (no extra main landmark). */
export function PageLoading() {
  return (
    <div role="status" aria-busy="true" className="flex min-h-[40vh] items-center justify-center p-8">
      <span aria-hidden="true" className="size-8 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
