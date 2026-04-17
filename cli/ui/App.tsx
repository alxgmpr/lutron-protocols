/**
 * App — root Ink component for the Open Bridge CLI.
 *
 * Layout:
 *   ┌──────────────────────────────┐
 *   │ PacketLog (flexGrow)         │
 *   │ [Overlay, if present]        │
 *   ├──────────────────────────────┤
 *   │ CommandPalette (if tabbing)  │
 *   │ Footer (separator + legend)  │
 *   │ InputLine                    │
 *   └──────────────────────────────┘
 */

import { Box } from "ink";
import { CommandPalette } from "./components/CommandPalette";
import { Footer } from "./components/Footer";
import { InputLine } from "./components/InputLine";
import { Overlay } from "./components/Overlay";
import { PacketLog } from "./components/PacketLog";
import { useAppState, useTerminalSize } from "./hooks";
import { store } from "./store";
import { useLineEditor } from "./useLineEditor";

export interface AppProps {
  /** Returns the candidate list for tab completion given the text before the
   *  cursor. Called on every Tab press, so it can reflect context. */
  getCompletions: (lineBeforeCursor: string) => string[];
  onSubmit: (line: string) => void;
  onQuit: () => void;
  onRedraw?: () => void;
}

export function App(props: AppProps) {
  const { columns, rows } = useTerminalSize();
  const { overlay, palette } = useAppState();

  // Reserve rows for the fixed footer region.
  // Base: separator(1) + legend(1) + input(1) = 3.
  const palRows = palette
    ? Math.max(
        1,
        Math.ceil(
          palette.matches.reduce((acc, m) => acc + m.length + 3, 0) /
            Math.max(1, columns - 2),
        ),
      )
    : 0;
  const overlayRows = overlay
    ? Math.min(overlay.lines.length + 3, Math.floor(rows / 2))
    : 0;
  const reserved = 3 + palRows + overlayRows;
  const logHeight = Math.max(1, rows - reserved);

  useLineEditor({
    onSubmit: props.onSubmit,
    onPageUp: () => store.scrollBy(-1, Math.max(1, Math.floor(logHeight / 2))),
    onPageDown: () => store.scrollBy(1, Math.max(1, Math.floor(logHeight / 2))),
    onEnd: () => store.scrollToLive(),
    onRedraw: () => {
      store.requestRedraw();
      props.onRedraw?.();
    },
    onQuit: props.onQuit,
    onAnyKey: () => store.clearOverlay(),
    getCompletions: props.getCompletions,
  });

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <PacketLog height={logHeight} />
      {overlay ? <Overlay width={columns} /> : null}
      {palette ? <CommandPalette width={columns} /> : null}
      <Footer width={columns} />
      <InputLine />
    </Box>
  );
}
