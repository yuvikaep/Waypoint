#!/bin/sh
set -eu
mkdir -p /run/waypoint-health
check_service() {
    service="$1"
    url="$2"
    counter="/run/waypoint-health/$service"
    started=$(systemctl show "$service" -p ActiveEnterTimestamp --value)
    if [ -n "$started" ]; then
        started_seconds=$(date -d "$started" +%s)
        if [ "$(($(date +%s) - started_seconds))" -lt 300 ]; then return; fi
    fi
    if curl --fail --silent --max-time 5 "$url" >/dev/null; then
        rm -f "$counter"
        return
    fi
    failures=0
    if [ -f "$counter" ]; then failures=$(cat "$counter"); fi
    failures=$((failures + 1))
    printf '%s\n' "$failures" > "$counter"
    if [ "$failures" -ge 3 ]; then
        logger -t waypoint-health "$service failed three consecutive health checks; restarting"
        systemctl restart "$service"
        rm -f "$counter"
    fi
}
check_service traccar http://127.0.0.1:8082/
check_service waypoint http://127.0.0.1:8180/api/gps/health
check_service caddy http://127.0.0.1:2019/config/
