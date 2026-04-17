/**
 * CommandPalette — floating chip list of tab completion matches.
 *
 * Rendered directly above the InputLine when store.palette is non-null.
 * The currently-selected match (tabIndex) is highlighted.
 */

import { Box, Text } from "ink";
import { useAppState } from "../hooks";

interface Props {
  width: number;
}

export function CommandPalette({ width }: Props) {
  const { palette } = useAppState();
  if (!palette) return null;

  // Compact chip layout: join matches with ' · ', highlight selected index.
  // Wrap to multiple rows if wider than terminal.
  const chips = palette.matches.map((m, i) => ({
    text: m,
    selected: i === palette.index,
  }));

  // Build rows greedily.
  const rows: Array<typeof chips> = [[]];
  let curLen = 0;
  for (const chip of chips) {
    const sep = rows[rows.length - 1].length === 0 ? 0 : 3; // " · "
    const need = sep + chip.text.length;
    if (curLen + need > width - 2) {
      rows.push([chip]);
      curLen = chip.text.length;
    } else {
      rows[rows.length - 1].push(chip);
      curLen += need;
    }
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, rowIdx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static per render
        <Text key={rowIdx}>
          {row.map((chip, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static per render
            <Text key={i}>
              {i > 0 ? <Text dimColor> · </Text> : null}
              <Text
                inverse={chip.selected}
                color={chip.selected ? "cyan" : undefined}
              >
                {chip.text}
              </Text>
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
