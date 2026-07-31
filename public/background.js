const enableActionClickToOpenPanel = () => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Could not enable the ImageFlow side panel.", error));
};

enableActionClickToOpenPanel();
chrome.runtime.onInstalled.addListener(enableActionClickToOpenPanel);
chrome.runtime.onStartup.addListener(enableActionClickToOpenPanel);
