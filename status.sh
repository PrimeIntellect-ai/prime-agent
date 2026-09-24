#!/bin/bash
ls -la /root/logs/ | head -20
echo ---
tail -12 /root/logs/chk_launch.log 2>/dev/null
echo --- ttc logs ---
for f in /root/logs/ttc_chk_*.log; do echo "== $f"; tail -8 "$f"; done
