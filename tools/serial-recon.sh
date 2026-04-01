#!/bin/bash
# RR-SEL-REP2 system reconnaissance via serial
PORT="/dev/tty.usbserial-4240"
BAUD=115200
OUT="/Volumes/Secondary/lutron-tools/data/rr-sel-rep2/recon.txt"

stty -f "$PORT" $BAUD cs8 -cstopb -parenb raw -echo -echoe -echok

# Drain any pending output
timeout 1 cat "$PORT" > /dev/null 2>&1 &
sleep 0.5
kill $! 2>/dev/null; wait $! 2>/dev/null

# Function to send command and capture output
send_cmd() {
    local cmd="$1"
    local wait="${2:-3}"
    echo "=== CMD: $cmd ===" >> "$OUT"
    # Start reader
    cat "$PORT" >> "$OUT" &
    local pid=$!
    # Send command
    printf "%s\r" "$cmd" > "$PORT"
    sleep "$wait"
    kill $pid 2>/dev/null
    wait $pid 2>/dev/null
    echo "" >> "$OUT"
}

# Clear output file
> "$OUT"

# Wake up with empty command
printf "\r" > "$PORT"
sleep 1

# System info
send_cmd "uname -a" 2
send_cmd "cat /etc/os-release" 2
send_cmd "cat /etc/version" 2
send_cmd "cat /etc/hostname" 2
send_cmd "uptime" 2

# Hardware
send_cmd "cat /proc/cpuinfo" 3
send_cmd "cat /proc/meminfo" 3
send_cmd "cat /proc/mtd" 2
send_cmd "cat /proc/cmdline" 2

# Storage
send_cmd "mount" 2
send_cmd "df -h" 2
send_cmd "cat /proc/partitions" 2

# Network
send_cmd "ifconfig" 3
send_cmd "ip addr" 3

# Processes
send_cmd "ps aux" 5
send_cmd "cat /etc/monitrc" 5

# Flash layout
send_cmd "ls -la /dev/mtd*" 3

# Key directories
send_cmd "ls -la /usr/local/lutron/bin/" 3
send_cmd "ls -la /usr/local/lutron/lib/" 3
send_cmd "ls -la /usr/local/lutron/db/" 3
send_cmd "ls -la /usr/local/lutron/ssl/" 3
send_cmd "ls -la /usr/local/lutron/conf/" 3
send_cmd "ls -la /etc/init.d/" 3

# Version info
send_cmd "cat /usr/local/lutron/conf/lutron.conf" 5
send_cmd "cat /usr/local/lutron/version" 2
send_cmd "strings /usr/local/lutron/bin/lutron-core | head -20" 3

echo "Recon complete. Output in $OUT"
