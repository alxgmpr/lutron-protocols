/**
 * PacketLog — windowed viewport over store.entries.
 *
 * Packets are rendered here, at view time, against the current width and
 * raw/verbose/filter state — so toggles and resizes re-layout the whole
 * buffer, not just new rows. Only the visible window is rendered.
 */

import { Box, Text } from "ink";
import { memo } from "react";
import { getPacketLayout, visibleLines } from "../../core/packets";
import { useAppState, useTerminalSize } from "../hooks";

interface Props {
  height: number;
}

export const PacketLog = memo(function PacketLog({ height }: Props) {
  const state = useAppState();
  const { columns } = useTerminalSize();
  const layout = getPacketLayout(state.raw, columns, state.verbose);
  const slice = visibleLines(
    state.entries,
    layout,
    state.filter?.match ?? null,
    height,
    -state.scrollOffset,
    state.selected,
  );
  const padCount = Math.max(0, height - slice.length);
  const visible =
    padCount > 0 ? [...Array(padCount).fill(""), ...slice] : slice;

  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {visible.map((line, i) => (
        // Line index is stable within the window; ANSI is preserved by Ink's
        // Text component when the string already contains escape codes.
        // biome-ignore lint/suspicious/noArrayIndexKey: windowed render by position
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
});
