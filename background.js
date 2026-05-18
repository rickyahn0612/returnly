chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('returnly-daily-check', {
    periodInMinutes: 60 * 24,
    delayInMinutes: 1,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'returnly-daily-check') checkDeadlines();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_BADGE') updateBadge(msg.count);
});

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: count <= 2 ? '#f97316' : '#ef4444' });
}

function checkDeadlines() {
  chrome.storage.local.get(['returnlyOrders'], (result) => {
    const orders = result.returnlyOrders || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const expiringSoon = orders.filter((order) => {
      const daysLeft = Math.ceil((new Date(order.returnDeadline) - today) / (1000 * 60 * 60 * 24));
      return daysLeft > 0 && daysLeft <= 7;
    });

    updateBadge(expiringSoon.length);

    expiringSoon.forEach((order) => {
      const daysLeft = Math.ceil((new Date(order.returnDeadline) - today) / (1000 * 60 * 60 * 24));
      if (daysLeft === 1 || daysLeft === 3) {
        const itemName = order.items[0] || 'An Amazon order';
        chrome.notifications.create(`returnly-${order.orderId}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: daysLeft === 1 ? '⚠️ Return window closes tomorrow!' : '📦 Return window closing soon',
          message: `${itemName} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left to return.`,
        });
      }
    });
  });
}

chrome.runtime.onStartup.addListener(checkDeadlines);
