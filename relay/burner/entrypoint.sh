#!/bin/bash
# Burner: pull program from MediaMTX, burn /shared/overlay.png (hot-reloaded
# by ffmpeg's image2 -loop on Linux — verified Phase 1), push to CF Stream.
#
# Robustness: ffmpeg writes -progress to a file; a watchdog kills it whenever
# the out_time counter stalls >20s (covers zombie sockets, half-open RTSP,
# publisher swaps, 5G dropouts — any stall, any disguise). The outer loop
# restarts it forever. If the overlay PNG is missing, stream WITHOUT it
# (video > scorebug).

# RTMP (not RTSP): both tracks arrive with timestamps from 0 → overlay
# framesync aligns with the image input naturally and A/V sync is native.
INPUT="${INPUT_URL:-rtmp://mediamtx:1935/live}"
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
     -shortest
     -progress "$PROG" -f flv "$OUT")

run_once() {
  rm -f "$PROG"
  if [ -f "$OVERLAY" ]; then
    echo "[burner] $(date '+%F %T') start (with overlay)"
    ffmpeg -hide_banner -loglevel warning \
      -thread_queue_size 512 -i "$INPUT" \
      -f image2 -loop 1 -framerate 2 -thread_queue_size 512 -i "$OVERLAY" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[b];[b][1:v]overlay=0:0[v]" \
      -map "[v]" "${ENC[@]}" &
  else
    echo "[burner] $(date '+%F %T') start (NO overlay png — streaming clean)"
    ffmpeg -hide_banner -loglevel warning \
      -thread_queue_size 512 -i "$INPUT" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[v]" \
      -map "[v]" "${ENC[@]}" &
  fi
  FFPID=$!

  # Watchdog: kill on STALL (frozen zombie) or RUNAWAY (encoding faster than
  # ~2x realtime — happens when the live input dies but the looping overlay
  # image keeps the encoder fed; a live feed can only advance at 1x).
  local last_ms=-1 same=0 fast=0
  while kill -0 "$FFPID" 2>/dev/null; do
    sleep 5
    local cur_ms
    cur_ms=$(grep -s out_time_ms "$PROG" | tail -1 | cut -d= -f2)
    cur_ms=$((${cur_ms:-0} / 1000))
    if [ "$last_ms" -ge 0 ]; then
      local delta=$((cur_ms - last_ms))
      if [ "$delta" -le 0 ]; then
        same=$((same + 5)); fast=0
      elif [ "$delta" -gt 10000 ]; then   # >10s of output in a 5s window
        fast=$((fast + 5)); same=0
      else
        same=0; fast=0
      fi
    fi
    last_ms=$cur_ms
    if [ "$same" -ge "$STALL_S" ]; then
      echo "[burner] $(date '+%F %T') WATCHDOG: progress stalled ${same}s — killing ffmpeg"
      kill -9 "$FFPID" 2>/dev/null; break
    fi
    if [ "$fast" -ge 10 ]; then
      echo "[burner] $(date '+%F %T') WATCHDOG: runaway encode (input dead?) — killing ffmpeg"
      kill -9 "$FFPID" 2>/dev/null; break
    fi
  done
  wait "$FFPID" 2>/dev/null
  echo "[burner] $(date '+%F %T') ffmpeg gone ($?)"
}

while true; do
  run_once
  sleep 3
done
