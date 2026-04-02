#!/usr/bin/env bash
# caseta-expand-limits.sh — Raise Caseta device limit from 100 to 200
# Patches BusinessRulesInfo and CandidateLinkNodeIndexInfo in lutron-db.sqlite
#
# Usage: ./tools/caseta-expand-limits.sh [max_devices]
#   max_devices defaults to 200

set -euo pipefail

CASETA_HOST="10.0.0.7"
SSH_KEY="$HOME/.ssh/id_ed25519_lutron"
DB_PATH="/var/db/lutron-db.sqlite"
MAX_DEVICES="${1:-200}"

MAX_LINK_NODE=$((MAX_DEVICES - 1))

ssh -i "$SSH_KEY" "root@$CASETA_HOST" sh -c "
set -eu
echo '=== Caseta device limit expansion ==='
echo 'Target: $MAX_DEVICES devices'

BACKUP=/tmp/lutron-db-pre-expand-\$(date +%Y%m%d-%H%M%S).sqlite
cp $DB_PATH \$BACKUP
echo \"Backup: \$BACKUP\"

echo ''
echo '--- Before ---'
sqlite3 $DB_PATH \"SELECT 'MaxNumberOfDevices: ' || MaxNumberOfDevices FROM BusinessRules;\"
sqlite3 $DB_PATH \"SELECT 'Link9 MaxNodeIndex: ' || MaxLinkNodeIndex FROM CandidateLinkNodeIndexInfo WHERE LinkTypeID = 9 AND LinkNodeTypeID = 0;\"
sqlite3 $DB_PATH \"SELECT 'Device count: ' || COUNT(*) FROM Device;\"

sqlite3 $DB_PATH \"UPDATE BusinessRulesInfo SET MaxNumberOfDevices = $MAX_DEVICES WHERE BusinessRulesInfoID = 3;\"
sqlite3 $DB_PATH \"UPDATE CandidateLinkNodeIndexInfo SET MaxLinkNodeIndex = $MAX_LINK_NODE WHERE LinkTypeID = 9 AND MaxLinkNodeIndex = 99;\"

echo ''
echo '--- After ---'
sqlite3 $DB_PATH \"SELECT 'MaxNumberOfDevices: ' || MaxNumberOfDevices FROM BusinessRules;\"
sqlite3 $DB_PATH \"SELECT 'Link9 MaxNodeIndex: ' || MaxLinkNodeIndex FROM CandidateLinkNodeIndexInfo WHERE LinkTypeID = 9 AND LinkNodeTypeID = 0;\"

echo ''
echo 'Done. Reboot to apply: reboot'
"
