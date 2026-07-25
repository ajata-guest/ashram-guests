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

// Only fires while the app is NOT the foreground tab — that's what
// "background" means here, not "the app is closed." The foreground case is
// handled separately in index.html's own onMessage() listener, since this
// handler never runs while the page is actually open and active.
messaging.onBackgroundMessage(payload => {
  const title = (payload.notification && payload.notification.title) || 'Ajatananda Ashram';
  const body = (payload.notification && payload.notification.body) || '';
  self.registration.showNotification(title, {
    body: body,
    icon: 'icon-192.png',
    badge: 'icon-64.png'
  });
});
