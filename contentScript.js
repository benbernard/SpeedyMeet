/*
 * contentScript.js is injected onto any meet.google.com page. This has different logic depending on if
 * it is running in the PWA or a normal tab. The PWA portion will redirect it to the correct meeting
 * (if not currently on a meeting). The normal tab will replace the content on the original page
 * informing the user they were redirected to the PWA.
 */

(() => {
  if (isPwa()) {
    setupPwaConnection();
  } else {
    setupRegularTabListener();
  }
})();

function setupPwaConnection() {
  const port = chrome.runtime.connect({ name: 'pwa-port' });

  port.onMessage.addListener(async (message) => {
    await handleNavigateMessage(message);
  });

  port.onDisconnect.addListener(() => {
    // Reconnect after a delay if disconnected
    setTimeout(setupPwaConnection, 1000);
  });

  // Also listen for direct messages (fallback when port disconnects)
  chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    await handleNavigateMessage(message);
  });
}

async function handleNavigateMessage(message) {
  if (message.action === 'NAVIGATE') {
    // Check if on call
    const onCall = await isUserOnCall();
    if (onCall) {
      return; // Don't interrupt active calls
    }

    // Navigate to new URL
    const targetUrl = 'https://meet.google.com/' + message.url;
    if (window.location.href !== targetUrl) {
      window.location.href = targetUrl;
    }
  }
}

async function isUserOnCall() {
  // Check for call_end icon (indicates active call)
  const icons = document.getElementsByClassName('google-material-icons');
  for (const icon of icons) {
    if (icon.textContent === 'call_end') {
      return true;
    }
  }
  return false;
}

function setupRegularTabListener() {
  // This function handles the case when a tab is opened but redirected to PWA
  // Since tabs close so quickly now, this rarely renders, but keeping for edge cases

  // Note: We can't use chrome.tabs.getCurrent() in content scripts
  // Instead, just show the UI if we detect any originating tab change
  // The background script will close the tab before this matters in most cases
  chrome.storage.onChanged.addListener(function (changes) {
    if (changes['originatingTabId'] && changes['originatingTabId'].newValue) {
      showRedirectingUI();
    }
  });
}

function showRedirectingUI() {
  // Stop current page load
  try {
    window.stop();
  } catch (error) {
    // Ignore if already stopped
  }

  // Create clean UI
  document.documentElement.innerHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          font-family: 'Google Sans', Roboto, Arial, sans-serif;
          background: #f8f9fa;
        }
        .container {
          text-align: center;
          padding: 48px;
        }
        .icon {
          width: 64px;
          height: 64px;
          margin: 0 auto 24px;
        }
        h1 {
          font-size: 24px;
          font-weight: 400;
          color: #202124;
          margin: 0 0 8px;
        }
        p {
          font-size: 14px;
          color: #5f6368;
          margin: 0;
        }
        .spinner {
          border: 3px solid #f3f3f3;
          border-top: 3px solid #1a73e8;
          border-radius: 50%;
          width: 40px;
          height: 40px;
          animation: spin 1s linear infinite;
          margin: 24px auto;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <img class="icon" src="${chrome.runtime.getURL('assets/ext-icon.png')}" />
        <h1>Opening in Google Meet PWA</h1>
        <div class="spinner"></div>
        <p>This tab will close automatically</p>
      </div>
    </body>
    </html>
  `;
}

function isPwa() {
  return ['fullscreen', 'standalone', 'minimal-ui'].some(
    (displayMode) =>
      window.matchMedia('(display-mode: ' + displayMode + ')').matches
  );
}
