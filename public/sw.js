self.addEventListener('push', function(event) {
  let data = { title: '🚖 Nuevo servicio disponible', body: 'Abre la app para verlo' };
  try { data = JSON.parse(event.data.text()); } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      vibrate: [200, 100, 200],
      tag: 'nuevo-servicio',
      renotify: true,
      data: { url: '/conductores' }
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (const client of clientList) {
        if (client.url.includes('/conductores') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/conductores');
    })
  );
});
