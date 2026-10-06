#!/bin/sh
# Runs as the UI container starts. Compose starts it only after the API is healthy, so the app is ready:
# print the address so `docker compose up` shows a link to click.
printf '\n  PRVision is ready: http://localhost:4210\n\n'
