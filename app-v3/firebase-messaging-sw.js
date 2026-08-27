importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.16.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAqlPQg_8Uzk35dEeEV1EQUKtGYTuCgoZw",
  authDomain: "ashram-guest-management.firebaseapp.com",
  projectId: "ashram-guest-management",
  storageBucket: "ashram-guest-management.firebasestorage.app",
  messagingSenderId: "454945412675",
  appId: "1:454945412675:web:94346f94135fac70f366f6"
});

const messaging = firebase.messaging();

// Only fires while the app is NOT the foreground tab — that is what
// "background" means here, not "the app is closed." The foreground case is
// handled in index.html's own onMessage listener, since this handler never
// runs while the page is actually open and in front of you.
messaging.onBackgroundMessage(payload => {
  const title = (payload.notification && payload.notification.title) || 'Ajatananda Ashram';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body: body,
    icon: 'icon-192.png',
    badge: 'icon-64.png',
    // Notifications about the same thing replace one another instead of
    // stacking up, so a morning's worth of saves leaves one line to read
    // rather than a column of near-identical banners.
    tag: (payload.data && payload.data.tag) || 'ashram-guest',
    data: { url: (payload.data && payload.data.url) || './' }
  });
});

// Tapping the notification should land in the app rather than opening a
// second copy of it — focus the tab that is already open where there is one.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
});
