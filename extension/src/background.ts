// Open the Workflow Runner side panel when the toolbar icon is clicked. All
// run logic lives in the panel page (it has chrome.debugger access and, unlike
// this service worker, isn't shut down during a multi-minute run).
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
