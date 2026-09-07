#!/bin/bash
cd /Users/amitmittelman/GitHub/Qualia-access

# Wait for network to be available (handles post-sleep wake-up)
for i in 1 2 3 4 5; do
  if /usr/bin/nc -zw3 8.8.8.8 53 > /dev/null 2>&1; then
    break
  fi
  echo "[run-all] Waiting for network ($i/5)..."
  sleep 5
done

# Each script runs independently — a failure in one (network blip, login
# timeout, etc.) must not prevent the others from running this hour.
status=0
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-closing-amendments.ts || status=1
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-docusign-completions.ts || status=1
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-labeled-emails.ts || status=1
/opt/homebrew/bin/npx ts-node src/scripts/automation/process-datatrace-bundle.ts || status=1
exit $status
