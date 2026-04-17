/**
 * Overlay — modal panel rendered over the packet log.
 *
 * Used for help text, CoAP scan results, status dumps, etc. Dismissed by
 * any keystroke (the App-level key handler clears the overlay on onAnyKey).
 */

import { Box, Text } from "ink";
import { useAppState } from "../hooks";

interface Props {
  width: number;
}

export function Overlay({ width }: Props) {
  const { overlay } = useAppState();
  if (!overlay) return null;

  const maxWidth = Math.max(20, Math.min(width - 4, 120));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={maxWidth}
      flexShrink={0}
    >
      {overlay.lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static-per-overlay list
        <Text key={i}>{line}</Text>
      ))}
      <Text dimColor>— press any key to dismiss —</Text>
    </Box>
  );
}
