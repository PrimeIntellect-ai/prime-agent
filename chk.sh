#!/bin/bash
# tui-transcript-condense compile check (unique log: /root/logs/ttc_chk_<pid>.log)
set -u
mkdir -p /root/logs /work
LOG=/root/logs/ttc_chk_$$.log
echo "=== ttc compile check start $(date -u +%FT%TZ)" >> $LOG
export RUSTUP_TOOLCHAIN=1.98.1
if ! rustup toolchain list | grep -q 1.98.1; then
  echo "=== installing toolchain 1.98.1" >> $LOG
  rustup toolchain install 1.98.1 --profile minimal >> $LOG 2>&1
  rustup component add --toolchain 1.98.1 rustfmt clippy >> $LOG 2>&1
fi
rustup default 1.98.1 >> $LOG 2>&1
rustc --version >> $LOG 2>&1
cd /work
rm -rf pa
mkdir pa
tar xzf /root/pa.tar.gz -C pa
cd /work/pa
export CARGO_INCREMENTAL=0
echo "=== cargo check -p pa-tui --all-targets" >> $LOG
cargo check -p pa-tui --all-targets >> $LOG 2>&1
echo "=== check exit: $?" >> $LOG
echo "=== ttc compile check done $(date -u +%FT%TZ)" >> $LOG
