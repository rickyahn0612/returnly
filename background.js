chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('returnalertz-daily-check', {
    periodInMinutes: 60 * 24,
    delayInMinutes: 1,
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'returnalertz-daily-check') checkDeadlines();
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'UPDATE_BADGE') updateBadge(msg.count);
  if (msg.type === 'SCAN_PAGES') startScan(msg.urls, msg.currentOrders, sender.tab.id);
  if (msg.type === 'PAGE_SCAN_RESULT') handleScanResult(msg.orders, sender.tab.id);
});

// --- Multi-page scan session ---
let scan = null;

function startScan(urls, currentOrders, originTabId) {
  if (scan) return; // already scanning (could be a message from a background scan tab — ignore)
  if (!urls || urls.length === 0) return;

  scan = {
    originTabId,
    pending: urls.length,
    orders: [...(currentOrders || [])],
  };

  scan.timer = setTimeout(() => {
    if (!scan) return;
    try { chrome.tabs.sendMessage(scan.originTabId, { type: 'SCAN_COMPLETE', orders: scan.orders }); } catch {}
    scan = null;
  }, 45000);

  urls.forEach(async (url) => {
    const scanUrl = url.includes('?') ? `${url}&_rt=1` : `${url}?_rt=1`;
    try {
      await chrome.tabs.create({ url: scanUrl, active: false });
    } catch {
      // Tab creation failed — count it as done so the scan can still complete
      if (scan) {
        scan.pending--;
        if (scan.pending <= 0) finishScan();
      }
    }
  });
}

function handleScanResult(orders, tabId) {
  if (!scan) return;

  (orders || []).forEach((order) => {
    const existing = scan.orders.find((o) => o.orderId === order.orderId);
    if (existing) {
      order.items.forEach((item) => {
        if (!existing.items.find((e) => (e.asin && e.asin === item.asin) || e.title === item.title)) {
          existing.items.push(item);
        }
      });
    } else {
      scan.orders.push(order);
    }
  });

  scan.pending--;
  chrome.tabs.remove(tabId).catch(() => {});

  if (scan.pending <= 0) finishScan();
}

function finishScan() {
  if (!scan) return;
  clearTimeout(scan.timer);
  try { chrome.tabs.sendMessage(scan.originTabId, { type: 'SCAN_COMPLETE', orders: scan.orders }); } catch {}
  scan = null;
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: count <= 2 ? '#f97316' : '#ef4444' });
}

function checkDeadlines() {
  chrome.storage.local.get(['returnAlertOrders'], (result) => {
    const orders = result.returnAlertOrders || [];
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
        const itemName = order.items[0]?.title || order.items[0] || 'An Amazon order';
        chrome.notifications.create(`returnalertz-${order.orderId}`, {
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: daysLeft === 1 ? '⚠️ Return window closes tomorrow!' : '📦 Return window closing soon',
          message: `${itemName} — ${daysLeft} day${daysLeft > 1 ? 's' : ''} left to return.`,
        });
      }
    });
  });
}

chrome.runtime.onStartup.addListener(checkDeadlines);
