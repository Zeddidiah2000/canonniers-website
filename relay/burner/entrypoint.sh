#!/bin/bash
# Burner: pull program from MediaMTX, burn /shared/overlay.png (hot-reloaded
# by ffmpeg's image2 -loop on Linux — verified Phase 1), push to CF Stream.
# Infinite restart loop; if the overlay PNG is missing, stream WITHOUT it
# (video > scorebug). A missing input just retries until the feed appears.

INPUT="${INPUT_URL:-rtsp://mediamtx:8554/live}"
OVERLAY="/shared/overlay.png"
OUT="${CF_RTMPS_URL}${CF_STREAM_KEY}"

if [ -z "$CF_STREAM_KEY" ]; then
  echo "[burner] CF_STREAM_KEY unset — nothing to do, sleeping"
  exec sleep infinity
fi

ENC=(-c:v libx264 -preset veryfast -b:v 6M -maxrate 6M -bufsize 12M
     -g 60 -pix_fmt yuv420p
     -map "0:a?" -c:a aac -b:a 128k -ar 44100
     -af "aresample=async=1:first_pts=0"
     -f flv "$OUT")

while true; do
  TS=$(date '+%F %T')
  if [ -f "$OVERLAY" ]; then
    echo "[burner] $TS start (with overlay)"
    ffmpeg -hide_banner -loglevel warning \
      -fflags +genpts -rtsp_transport tcp -timeout 10000000 -thread_queue_size 512 -i "$INPUT" \
      -f image2 -loop 1 -framerate 2 -i "$OVERLAY" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[b];[b][1:v]overlay=0:0[v]" \
      -map "[v]" "${ENC[@]}"
  else
    echo "[burner] $TS start (NO overlay png — streaming clean)"
    ffmpeg -hide_banner -loglevel warning \
      -fflags +genpts -rtsp_transport tcp -timeout 10000000 -thread_queue_size 512 -i "$INPUT" \
      -filter_complex "[0:v]scale=1920:1080,fps=30[v]" \
      -map "[v]" "${ENC[@]}"
  fi
  echo "[burner] $(date '+%F %T') ffmpeg exited ($?) — retry in 3s"
  sleep 3
done
