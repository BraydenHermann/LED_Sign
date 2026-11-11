// Service Worker for LED Sign Notifications
// Handles background notifications and inline action inputs

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const enteredPasscode = event.reply;
  const notifData = event.notification.data || {};
  const targetAddress = notifData.address;

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // Find an existing open window/tab
      let targetClient = allClients.find((c) => 'focus' in c);

      if (targetClient) {
        try {
          await targetClient.focus();
        } catch (e) {
          console.warn('[SW] Could not focus client:', e);
        }

        if (notifData.type === 'PASSCODE') {
          targetClient.postMessage({
            type: 'PASSCODE_FROM_NOTIFICATION',
            passcode: (typeof enteredPasscode === 'string' && enteredPasscode.trim()) ? enteredPasscode.trim() : null,
            address: targetAddress,
            action: event.action,
          });
        }
      } else if (self.clients.openWindow) {
        const urlToOpen = (notifData.type === 'PASSCODE' && targetAddress)
          ? `/?passcodePrompt=${encodeURIComponent(targetAddress)}`
          : '/';
        const newClient = await self.clients.openWindow(urlToOpen);
        if (newClient && notifData.type === 'PASSCODE' && enteredPasscode) {
          setTimeout(() => {
            try {
              newClient.postMessage({
                type: 'PASSCODE_FROM_NOTIFICATION',
                passcode: (typeof enteredPasscode === 'string' && enteredPasscode.trim()) ? enteredPasscode.trim() : null,
                address: targetAddress,
                action: event.action,
              });
            } catch (e) {}
          }, 1200);
        }
      }
    })()
  );
});
