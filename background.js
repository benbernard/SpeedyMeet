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
  console.log('[SpeedyMeet] Initializing PWA state...');
  const windows = await chrome.windows.getAll({
    populate: true,
    windowTypes: ['app'],
  });

  console.log('[SpeedyMeet] Found app windows:', windows.length);
  for (const window of windows) {
    console.log('[SpeedyMeet] Checking window:', window.id, window.tabs[0]?.url);
    if (isPwaWindow(window)) {
      pwaState.windowId = window.id;
      pwaState.tabId = window.tabs[0].id;
      pwaState.isOpen = true;
      console.log('[SpeedyMeet] PWA detected! Window ID:', window.id);
      break;
    }
  }
  console.log('[SpeedyMeet] PWA state after init:', pwaState);
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
chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name === 'pwa-port') {
    console.log('[SpeedyMeet] PWA port connected!', port.sender);
    pwaState.port = port;

    // Update PWA state from the port sender info
    if (port.sender?.tab) {
      pwaState.tabId = port.sender.tab.id;
      pwaState.windowId = port.sender.tab.windowId;
      pwaState.isOpen = true;
      console.log('[SpeedyMeet] Updated PWA state from port:', pwaState);
    }

    port.onDisconnect.addListener(() => {
      console.log('[SpeedyMeet] PWA port disconnected');
      pwaState.port = null;
    });
  }
});

// Early navigation interception - fires BEFORE page loads
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    console.log('[SpeedyMeet] webNavigation fired:', details.url, 'frameId:', details.frameId, 'tabId:', details.tabId);

    // Skip subframes, PWA tabs, and back/forward navigations
    if (details.frameId !== 0 || details.tabId === pwaState.tabId) {
      console.log('[SpeedyMeet] Skipping - subframe or PWA tab');
      return;
    }

    const url = new URL(details.url);
    const meetingCode = url.pathname.split('/').filter(Boolean)[0] || '';
    console.log('[SpeedyMeet] Meeting code:', meetingCode, 'PWA state:', pwaState);

    // Handle /new URLs specially
    if (meetingCode === 'new') {
      console.log('[SpeedyMeet] Handling /new meeting');
      await handleNewMeeting(details.tabId, url);
      return;
    }

    // Skip landing page and special URLs
    if (!meetingCode || meetingCode.startsWith('_meet')) {
      console.log('[SpeedyMeet] Skipping - landing page or special URL');
      return;
    }

    console.log('[SpeedyMeet] Handling meeting redirect');
    await handleMeetingRedirect(details.tabId, url);
  },
  { url: [{ hostEquals: 'meet.google.com' }] }
);

async function handleMeetingRedirect(tabId, url) {
  // If port is connected, PWA is definitely open (trust the connection over window detection)
  const pwaIsOpen = pwaState.isOpen || pwaState.port !== null;

  if (!pwaIsOpen) {
    // Show notification
    console.log('[SpeedyMeet] PWA not detected, showing notification');
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'assets/ext-icon.png',
      title: 'SpeedyMeet',
      message: 'Open Google Meet PWA for instant redirects',
    });
    return;
  }

  console.log('[SpeedyMeet] PWA is open, proceeding with redirect');

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

  // Send to PWA via port (instant!) or fallback to sendMessage
  if (pwaState.port) {
    pwaState.port.postMessage({
      action: 'NAVIGATE',
      url: targetUrl,
    });
  } else if (pwaState.tabId) {
    // Port disconnected, fall back to direct tab message
    console.log('[SpeedyMeet] Port disconnected, using sendMessage fallback');
    try {
      await chrome.tabs.sendMessage(pwaState.tabId, {
        action: 'NAVIGATE',
        url: targetUrl,
      });
    } catch (error) {
      console.log('[SpeedyMeet] Could not send message to PWA:', error);
      return; // Don't close tab if we couldn't send message
    }
  } else {
    console.log('[SpeedyMeet] No port and no tabId, cannot redirect');
    return; // Don't close tab if we can't redirect
  }

  // Close immediately (no delay!)
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // Tab might have already been closed
    console.log('Could not close tab:', error);
  }

  // Focus PWA
  if (pwaState.windowId) {
    try {
      await chrome.windows.update(pwaState.windowId, { focused: true });
    } catch (error) {
      console.log('[SpeedyMeet] Could not focus PWA window:', error);
    }
  } else if (pwaState.tabId) {
    // If we have tabId but no windowId, try to get window from tab
    try {
      const tab = await chrome.tabs.get(pwaState.tabId);
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (error) {
      console.log('[SpeedyMeet] Could not focus PWA via tabId:', error);
    }
  }
}

async function handleNewMeeting(tabId, url) {
  // If port is connected, PWA is definitely open (trust the connection over window detection)
  const pwaIsOpen = pwaState.isOpen || pwaState.port !== null;

  if (!pwaIsOpen) {
    // For /new URLs, allow normal tab load if PWA not open
    // This is for users initiating a new meeting
    console.log('[SpeedyMeet] PWA not open for /new, allowing normal tab load');
    return;
  }

  console.log('[SpeedyMeet] PWA is open, redirecting /new to PWA');

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
  } else if (pwaState.tabId) {
    // Port disconnected, fall back to direct tab message
    console.log('[SpeedyMeet] Port disconnected, using sendMessage fallback for /new');
    try {
      await chrome.tabs.sendMessage(pwaState.tabId, {
        action: 'NAVIGATE',
        url: 'new' + queryString,
        isNewMeeting: true,
      });
    } catch (error) {
      console.log('[SpeedyMeet] Could not send message to PWA:', error);
      return; // Don't close tab if we couldn't send message
    }
  } else {
    console.log('[SpeedyMeet] No port and no tabId, cannot redirect /new');
    return; // Don't close tab if we can't redirect
  }

  // Close origin tab immediately (no delay for /new)
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    console.log('Could not close tab:', error);
  }

  // Focus PWA
  if (pwaState.windowId) {
    try {
      await chrome.windows.update(pwaState.windowId, { focused: true });
    } catch (error) {
      console.log('[SpeedyMeet] Could not focus PWA window:', error);
    }
  } else if (pwaState.tabId) {
    // If we have tabId but no windowId, try to get window from tab
    try {
      const tab = await chrome.tabs.get(pwaState.tabId);
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (error) {
      console.log('[SpeedyMeet] Could not focus PWA via tabId:', error);
    }
  }
}
