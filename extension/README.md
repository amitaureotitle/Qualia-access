# Workflow Runner (Chrome extension)

One extension for **every** Pipeline-dashboard workflow. Use it to watch a
workflow run live in your own Qualia tab before it goes to GitHub, or to
trigger one by hand.

## How it works

The extension holds no workflow logic. It's a "remote hand":

```
GitHub (production)                         Your Mac (testing)
python -m post_closing.closeout             same Python code, started from the panel
        │ HTTP                                      │ HTTP
Qualia-access on Vercel                     Qualia-access locally, DRIVER=bridge   ← same src/steps code
        │ Playwright                                │ WebSocket ws://localhost:3001/bridge
Browserbase                                 this extension → your tab              ← only this differs
```

- **Workflows** register in Pipeline-dashboard's `workflows/registry.py` and
  show up in the panel's dropdown automatically.
- **Changing a workflow** means editing the Python or `src/steps/*`, then
  restarting the dev servers. The extension needs no rebuild.
- **Rebuild only** when the extension itself changes (`npm run build:extension`),
  then press reload on it in `chrome://extensions`.

## Setup (once)

```
# Qualia-access
npm install
npm run build:extension
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick this
`extension/` folder. Pin **Aureo Workflow Runner**; clicking it opens the side panel.

## Every session

From Pipeline-dashboard:

```
scripts/dev_workflows.sh
```

This starts the dashboard (:5001, with the local dev API on) and Qualia-access
(:3001, bridge mode), wired to each other. Ctrl-C stops both. The panel's two
dots turn green when it can reach both.

## Use

1. Open an order in Qualia (or type an order number), then pick a workflow.
   The panel shows what's saved for that order and the plan.
2. Every **Run** starts by fetching the latest data: Qualia's API, then any
   pages the workflow reads, like the Recording page. There's no separate
   fetch step, so a run never works from stale data. The data panel
   refreshes as the run goes.
3. Pick **Dry run** (fills everything in, never clicks anything irreversible)
   or **Live** (does it all for real; the panel turns red and asks once).
4. **Run**:
   - Before every click, keystroke or page change, the target gets an orange
     outline and a label on the page ("Click "Send Message"", "Type recipient
     …"), and the panel's **Now** box counts down. The pause is set in
     Settings: 2 s by default, down to "None (real speed)" for a final pass.
   - **Pause/Resume** works between any two actions. **Stop** halts the run;
     if it stops before an irreversible click, that step can be retried later.
   - Before Issue / Send / "Close Order", a red banner appears and the panel
     waits for **Continue** (you can turn this off in Settings).
5. **▶ from here** (dry runs) on a Plan step starts the dry run at that step
   and skips the earlier *actions*. The data is still fetched fresh.
6. **Recent runs** lists local and GitHub runs of every workflow. **View**
   shows a run's log; **Copy log** puts the full text on the clipboard.

Chrome shows a "started debugging this browser" bar during a run, and its
Cancel button stops the run. Don't use the tab while a run is going.

## Logs

Every run is logged to Pipeline-dashboard's `workflow_run_logs` table, from
both sides:
- **wf**: the workflow's own Python steps.
- **tab**: every browser action as performed here, plus a screenshot and the
  page URL at the first failure.

GitHub runs log to the same table. Read any run with
`python -m workflows.logs [order|run_id] [--debug]`.
