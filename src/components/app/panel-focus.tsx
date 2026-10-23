"use client";

import { useEffect } from "react";

// Keeps keyboard focus sensible while the page updates in place. When a suggested replacement appears because the tutor
// pressed Replace, focus moves to the panel; when the panel goes away (Accept / Keep original) focus returns to Replace.
// Focusing never scrolls (preventScroll), so the window stays where it was. A page load with a pending panel steals nothing.
export function PanelFocus({ number }: { number: number }) {
  useEffect(() => {
    const replace = document.getElementById(`replace-${number}`);
    if (document.activeElement === replace) document.getElementById(`candidate-panel-${number}`)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const panel = document.getElementById(`candidate-panel-${number}`);
      // Only when focus was inside the panel that is going away (or already lost to <body>).
      if (!active || active === document.body || (panel && panel.contains(active))) document.getElementById(`replace-${number}`)?.focus({ preventScroll: true });
    };
  }, [number]);
  return null;
}
