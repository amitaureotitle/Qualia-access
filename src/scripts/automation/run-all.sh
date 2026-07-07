#!/bin/bash
set -e
cd /Users/amitmittelman/GitHub/Qualia-access

# Wait for network to be available (handles post-sleep wake-up)
for i in 1 2 3 4 5; do
  if /usr/bin/nc -zw3 8.8.8.8 53 > /dev/null 2>&1; then
    break
  fi
  echo "[run-all] Waiting for network ($i/5)..."
  sleep 5
done

/opt/homebrew/bin/npx ts-node src/scripts/automation/process-closing-amendments.ts
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-docusign-completions.ts
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-labeled-emails.ts
