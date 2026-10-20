"use client";

import * as React from "react";

type PreparePendingValue = { pending: boolean; start: React.TransitionStartFunction };

const PreparePendingContext = React.createContext<PreparePendingValue>({ pending: false, start: (callback) => void callback() });

/** Shares the "a selection navigation is pending" flag between the dropdowns and the generate button. */
export function PreparePendingProvider({ children }: { children: React.ReactNode }) {
  const [pending, start] = React.useTransition();
  const value = React.useMemo(() => ({ pending, start }), [pending, start]);
  return <PreparePendingContext.Provider value={value}>{children}</PreparePendingContext.Provider>;
}

export function usePreparePending(): PreparePendingValue {
  return React.useContext(PreparePendingContext);
}
