#!/bin/bash
# Poll packets every 500ms forever until Ctrl+C
FILENAME="${1:-vive-capture-$(date +%s).jsonl}"
LAST=""

echo "Recording to: $FILENAME (polling mode)"
echo "Ctrl+C to stop"

while true; do
  DATA=$(curl -s 'http://localhost:5001/api/packets?limit=50')
  echo "$DATA" | jq -c '.[]' 2>/dev/null | while read -r line; do
    HASH=$(echo "$line" | md5)
    if ! grep -q "$HASH" /tmp/seen_packets_$$ 2>/dev/null; then
      echo "$HASH" >> /tmp/seen_packets_$$
      echo "$line" >> "$FILENAME"
      echo "$line"
    fi
  done
  sleep 0.5
done
