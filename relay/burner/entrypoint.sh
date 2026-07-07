#!/bin/bash
# Burner: pull program from MediaMTX, burn /shared/overlay.png (hot-reloaded
# by ffmpeg's image2 -loop on Linux — verified Phase 1), push to CF Stream.
#
# Robustness: ffmpeg writes -progress to a file; a watchdog kills it whenever
# the out_time counter stalls >20s (covers zombie sockets, half-open RTSP,
# publisher swaps, 5G dropouts — any stall, any disguise). The outer loop
# restarts it forever. If the overlay PNG is missing, stream WITHOUT it
# (video > scorebug).

INPUT="${INPUT_URL:-rtsp://mediamtx:8554/live}"
OVERLAY="/shared/overlay.png"
OUT="${CF_RTMPS_URL}${CF_STREAM_KEY}"
PROG=/tmp/ff_progress
STALL_S="${STALL_S:-20}"

if [ -z "$CF_STREAM_KEY" ]; then
  echo "[burner] CF_STREAM_KEY unset — nothing to do, sleeping"
  exec sleep infinity
fi

ENC=(-c:v libx264 -preset veryfast -b:v 6M -maxrate 6M -bufsize 12M
     -g 60 -pix_fmt yuv420p
     -map "0:a?" -c:a aac -b:a 128k -ar 44100
     -af "aresample=async=1"
     -progress "$PROG" -f flv "$OUT")

run_once() {
  rm -f "$PROG"
  if [ -f "$OVERLAY" ]; then
    echo "[burner] $(date '+%F %T') start (with overlay)"
    # Both inputs stamped from the same wallclock → overlay framesync aligns
    # (fixes the 2fps enslavement) WITHOUT per-stream pts resets (which broke
    # A/V sync by the keyframe-wait offset). Muxer shifts all streams uniformly.
    ffmpeg -hide_banner -loglevel warning \
      -use_wallclock_as_timestamps 1 -rtsp_transport tcp -timeout 10000000 -thread_queue_size 512 -i "$INPUT" \
      -use_wallclock_as_timestamps 1 -f image2 -loop 1 -framerate 2 -thread_queue_size 512 -i "$OVERLAY" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[b];[b][1:v]overlay=0:0[v]" \
      -map "[v]" "${ENC[@]}" &
  else
    echo "[burner] $(date '+%F %T') start (NO overlay png — streaming clean)"
    ffmpeg -hide_banner -loglevel warning \
      -use_wallclock_as_timestamps 1 -rtsp_transport tcp -timeout 10000000 -thread_queue_size 512 -i "$INPUT" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[v]" \
      -map "[v]" "${ENC[@]}" &
  fi
  FFPID=$!

  local last="" same=0
  while kill -0 "$FFPID" 2>/dev/null; do
    sleep 5
    local cur
    cur=$(grep -s out_time_ms "$PROG" | tail -1)
    if [ -n "$cur" ] && [ "$cur" == "$last" ]; then
      same=$((same + 5))
    else
      same=0
      last="$cur"
    fi
    if [ "$same" -ge "$STALL_S" ]; then
      echo "[burner] $(date '+%F %T') WATCHDOG: progress stalled ${same}s — killing ffmpeg"
      kill -9 "$FFPID" 2>/dev/null
      break
    fi
  done
  wait "$FFPID" 2>/dev/null
  echo "[burner] $(date '+%F %T') ffmpeg gone ($?)"
}

while true; do
  run_once
  sleep 3
done
