/**
 * PacketLog — windowed viewport over store.lines.
 *
 * Only renders the visible slice (tail of the buffer, offset by scrollOffset
 * when user has PgUp'd). Each line is emitted as-is — pre-rendered ANSI
 * strings from packets.renderRow().
 */

import { Box, Text } from "ink";
import { memo } from "react";
import { useAppState } from "../hooks";

interface Props {
  height: number;
}

export const PacketLog = memo(function PacketLog({ height }: Props) {
  const state = useAppState();
  const total = state.lines.length;
  const end = Math.max(0, total + state.scrollOffset);
  const start = Math.max(0, end - height);
  const slice = state.lines.slice(start, end);
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
