/**
 * DevicePanel — per-device RSSI and inter-packet gap sparklines and CCA
 * slot-tracker state for the most recently heard devices (see
 * core/sparkline.ts). Toggled by `devices`.
 */

import { Box, Text } from "ink";
import { memo, useMemo } from "react";
import { DIM, RESET } from "../../core/packets";
import {
  deviceStats,
  PANEL_FIXED_WIDTH,
  renderDevicePanel,
} from "../../core/sparkline";
import { useAppState } from "../hooks";

/** Separator + header + this many device lines. */
export const DEVICE_LINES = 6;
export const DEVICE_PANEL_ROWS = DEVICE_LINES + 2;

export const DevicePanel = memo(function DevicePanel({
  width,
}: {
  width: number;
}) {
  const { entries, filter } = useAppState();
  // The two sparklines share what the fixed columns leave.
  const samples = Math.max(8, Math.floor((width - PANEL_FIXED_WIDTH - 1) / 2));
  const lines = useMemo(
    () =>
      renderDevicePanel(
        deviceStats(entries, filter?.match ?? null, DEVICE_LINES, samples),
        samples,
      ),
    [entries, filter, samples],
  );
  return (
    <Box flexDirection="column" height={DEVICE_PANEL_ROWS} flexShrink={0}>
      <Text wrap="truncate-end">
        {`${DIM}${"─".repeat(Math.max(1, width - 1))}${RESET}`}
      </Text>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-layout pane
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
});
