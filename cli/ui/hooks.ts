/**
 * React hooks for subscribing to the Ink UI store and terminal size.
 */

import { useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";
import { type AppState, store } from "./store";

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 120,
    rows: stdout.rows || 24,
  });

  useEffect(() => {
    const handler = () => {
      setSize({ columns: stdout.columns || 120, rows: stdout.rows || 24 });
    };
    stdout.on("resize", handler);
    return () => {
      stdout.off("resize", handler);
    };
  }, [stdout]);

  return size;
}
