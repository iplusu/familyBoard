// 부모 폰 알림: 서버가 보낸 (내용 없는) 푸시를 받으면 새 쪽지를 읽어서 알림을 띄움
const NAMES = { en: { mom: 'Mom', dad: 'Dad', title: 'New message', more: 'more' }, ko: { mom: '엄마', dad: '아빠', title: '새 쪽지', more: '개 더' } };

self.addEventListener('push', (e) => e.waitUntil((async () => {
  let title = '📮 Family Board', body = '';
  try {
    const s = await (await fetch('/api?r=state')).json();
    const L = NAMES[s.me.lang] || NAMES.en;
    const name = (m) => L[m] || s.kids.find((k) => k.id === m)?.name || '';
    const unread = s.mail.filter((m) => m.to.includes(s.me.member) && !m.readBy.includes(s.me.member));
    title = '📮 ' + L.title;
    if (unread[0]) {
      title = `📮 ${name(unread[0].from)}`;
      body = unread[0].text + (unread.length > 1 ? ` (+${unread.length - 1} ${L.more})` : '');
    }
  } catch {}
  await self.registration.showNotification(title, { body, tag: 'mail', renotify: true }); // 푸시마다 알림은 꼭 띄워야 함
})()));

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((ws) => ws[0] ? ws[0].focus() : self.clients.openWindow('/?mail=1')));
});
