#!/bin/sh
# Runs as the UI container starts. Compose starts it only after the API is healthy, so the app is ready.
# This is the one message `docker compose up` shows; the other services are not attached.
printf '\n'
printf '  \033[1;32m✓\033[0m \033[1mPRVision is ready\033[0m\n'
printf '\n'
printf '    Open   \033[4mhttp://localhost:4210\033[0m\n'
printf '    Stop   Ctrl+C\n'
printf '    Logs   docker compose logs -f\n'
printf '\n'
