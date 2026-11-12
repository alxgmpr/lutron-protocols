/**
 * App — root Ink component for the Open Bridge CLI.
 *
 * Layout:
 *   ┌──────────────────────────────┐
 *   │ PacketLog (flexGrow)         │
 *   │ [Detail, if selecting]       │
 *   │ [Overlay, if present]        │
 *   ├──────────────────────────────┤
 *   │ CommandPalette (if tabbing)  │
 *   │ Footer (separator + legend)  │
 *   │ InputLine                    │
 *   └──────────────────────────────┘
 */

import { Box } from "ink";
import { entryAtLine, isText } from "../core/packets";
import { CommandPalette } from "./components/CommandPalette";
import { Detail } from "./components/Detail";
import { Footer } from "./components/Footer";
import { InputLine } from "./components/InputLine";
import { Overlay } from "./components/Overlay";
import { PacketLog } from "./components/PacketLog";
import { useAppState, useTerminalSize } from "./hooks";
import { store } from "./store";
import { type MouseEvent, useLineEditor } from "./useLineEditor";

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const LEFT = 0;
/** Shift/meta/ctrl bits in an SGR button code. */
const MODIFIERS = 4 | 8 | 16;

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
  const { overlay, palette, selected } = useAppState();

  // Reserve rows for the fixed footer region.
  // Base: separator(1) + column headers(1) + status(1) + input(1) = 4.
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
  // Fixed so a selection made before the pane opens stays in view after.
  const detailRows = Math.min(12, Math.floor(rows / 2));
  const reserved = 4 + palRows + overlayRows;
  const logHeight = Math.max(1, rows - reserved - (selected ? detailRows : 0));
  const selectHeight = Math.max(1, rows - reserved - detailRows);
  const halfPage = Math.max(1, Math.floor(selectHeight / 2));

  // The log is the top `logHeight` rows, bottom-anchored on the tail.
  const onMouse = ({ button, y, press }: MouseEvent) => {
    const b = button & ~MODIFIERS;
    const s = store.getState();
    if (b === WHEEL_UP || b === WHEEL_DOWN) {
      const dir = b === WHEEL_UP ? -1 : 1;
      if (s.selected) store.moveSelection(dir, selectHeight);
      else store.scrollBy(dir, 3, logHeight);
      return;
    }
    if (b !== LEFT || !press || y > logHeight) return;
    const e = entryAtLine(
      s.entries,
      s.verbose,
      s.filter?.match ?? null,
      -s.scrollOffset + logHeight - y,
    );
    if (!e || isText(e)) return;
    if (e === s.selected) store.clearSelection();
    else store.selectRow(e, selectHeight);
  };

  useLineEditor({
    onMouse,
    onSubmit: props.onSubmit,
    onPageUp: () =>
      store.getState().selected
        ? store.moveSelection(-halfPage, selectHeight)
        : store.scrollBy(-1, Math.max(1, Math.floor(logHeight / 2)), logHeight),
    onPageDown: () =>
      store.getState().selected
        ? store.moveSelection(halfPage, selectHeight)
        : store.scrollBy(1, Math.max(1, Math.floor(logHeight / 2)), logHeight),
    isSelecting: () => store.getState().selected !== null,
    onSelect: (step) => store.moveSelection(step, selectHeight),
    onSelectExit: () => store.clearSelection(),
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
      {selected ? (
        <Detail row={selected} height={detailRows} width={columns} />
      ) : null}
      {overlay ? <Overlay width={columns} /> : null}
      {palette ? <CommandPalette width={columns} /> : null}
      <Footer width={columns} />
      <InputLine />
    </Box>
  );
}
