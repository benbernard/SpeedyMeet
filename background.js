/*
 * background.js runs in the background on Chrome. It has access to manage the windows/tabs.
 * This will start the process to redirect the open tab into the PWA.
 */

// PWA State Management
let pwaState = {
  windowId: null,
  tabId: null,
  isOpen: false,
  port: null,
};

// Initialize: Check if PWA is already open on extension load
chrome.runtime.onStartup.addListener(initializePwaState);
chrome.runtime.onInstalled.addListener(initializePwaState);

async function initializePwaState() {
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ['app'],
  });

  for (const window of windows) {
    if (isPwaWindow(window)) {
      pwaState.windowId = window.id;
      pwaState.tabId = window.tabs[0].id;
      pwaState.isOpen = true;
      break;
    }
  }
}

function isPwaWindow(window) {
  return (
    window.tabs.length === 1 &&
    window.tabs[0].url?.startsWith('https://meet.google.com/')
  );
}

// Track PWA lifecycle
chrome.windows.onCreated.addListener(async (window) => {
  if (window.type === 'app') {
    const tabs = await chrome.tabs.query({ windowId: window.id });
    if (tabs[0]?.url?.startsWith('https://meet.google.com/')) {
      pwaState.windowId = window.id;
      pwaState.tabId = tabs[0].id;
      pwaState.isOpen = true;
    }
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === pwaState.windowId) {
    pwaState.port?.disconnect();
    pwaState = { windowId: null, tabId: null, isOpen: false, port: null };
  }
});

// Port Connection Handler
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'pwa-port') {
    pwaState.port = port;
    port.onDisconnect.addListener(() => {
      pwaState.port = null;
    });
  }
});

// Early navigation interception - fires BEFORE page loads
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    // Skip subframes, PWA tabs, and back/forward navigations
    if (details.frameId !== 0 || details.tabId === pwaState.tabId) {
      return;
    }

    const url = new URL(details.url);
    const meetingCode = url.pathname.split('/').filter(Boolean)[0] || '';

    // Handle /new URLs specially
    if (meetingCode === 'new') {
      await handleNewMeeting(details.tabId, url);
      return;
    }

    // Skip landing page and special URLs
    if (!meetingCode || meetingCode.startsWith('_meet')) {
      return;
    }

    await handleMeetingRedirect(details.tabId, url);
  },
  { url: [{ hostEquals: 'meet.google.com' }] }
);

async function handleMeetingRedirect(tabId, url) {
  if (!pwaState.isOpen) {
    // Show notification
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'assets/ext-icon.png',
      title: 'SpeedyMeet',
      message: 'Open Google Meet PWA for instant redirects',
    });
    return;
  }

  // Stop page load immediately
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.stop(),
      injectImmediately: true,
    });
  } catch (error) {
    // Tab might have already been closed or navigated away
    console.log('Could not stop page load:', error);
  }

  // Preserve authuser parameter (or add default)
  let queryString = url.search;
  if (!queryString) {
    queryString = '?authuser=0';
  } else if (!queryString.includes('authuser=')) {
    queryString += '&authuser=0';
  }
  const targetUrl = url.pathname.substring(1) + queryString;

  // Send to PWA via port (instant!)
  if (pwaState.port) {
    pwaState.port.postMessage({
      action: 'NAVIGATE',
      url: targetUrl,
    });
  }

  // Close immediately (no delay!)
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // Tab might have already been closed
    console.log('Could not close tab:', error);
  }

  // Focus PWA
  try {
    await chrome.windows.update(pwaState.windowId, { focused: true });
  } catch (error) {
    console.log('Could not focus PWA window:', error);
  }
}

async function handleNewMeeting(tabId, url) {
  if (!pwaState.isOpen) {
    // For /new URLs, allow normal tab load if PWA not open
    // This is for users initiating a new meeting
    return;
  }

  // Stop loading immediately
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.stop(),
      injectImmediately: true,
    });
  } catch (error) {
    console.log('Could not stop page load for /new:', error);
  }

  // /new requires special handling - server creates meeting
  // We need to let PWA navigate to /new
  let queryString = url.search;
  if (!queryString) {
    queryString = '?authuser=0';
  } else if (!queryString.includes('authuser=')) {
    queryString += '&authuser=0';
  }

  if (pwaState.port) {
    pwaState.port.postMessage({
      action: 'NAVIGATE',
      url: 'new' + queryString,
      isNewMeeting: true,
    });
  }

  // Close origin tab immediately (no delay for /new)
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.log('Could not close tab:', error);
  }

  // Focus PWA
  try {
    await chrome.windows.update(pwaState.windowId, { focused: true });
  } catch (error) {
    console.log('Could not focus PWA window:', error);
  }
}
