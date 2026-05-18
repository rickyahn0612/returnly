const loading = document.getElementById('loading');
const empty = document.getElementById('empty');
const orderList = document.getElementById('order-list');
const totalCount = document.getElementById('total-count');
const clearBtn = document.getElementById('clear-btn');
const resetBtn = document.getElementById('reset-btn');

function dismissKey(orderId, title) {
  return `${orderId}::${title}`;
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(dateStr) - today) / (1000 * 60 * 60 * 24));
}

function urgencyLevel(days) {
  if (days <= 0) return 'critical';
  if (days <= 3) return 'critical';
  if (days <= 10) return 'warning';
  return 'ok';
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysLabel(days) {
  if (days === 0) return 'Today!';
  if (days === 1) return '1 day left';
  if (days < 0) return 'Expired';
  return `${days} days left`;
}

function amazonOrderUrl(orderId) {
  return `https://www.amazon.com/gp/your-account/order-details/?orderId=${orderId}`;
}

function amazonItemUrl(orderId, asin) {
  if (asin) return `https://www.amazon.com/your-orders/pop?orderId=${orderId}&asin=${asin}`;
  return amazonOrderUrl(orderId);
}

function renderOrders(orders, dismissed = new Set()) {
  loading.style.display = 'none';
  orderList.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const active = orders
    .filter((o) => daysUntil(o.returnDeadline) >= 0)
    .sort((a, b) => new Date(a.returnDeadline) - new Date(b.returnDeadline));

  if (active.length === 0) {
    empty.style.display = 'block';
    totalCount.textContent = '';
    return;
  }

  orderList.style.display = 'block';
  const totalItems = active.reduce((sum, o) => sum + Math.max(o.items.length, 1), 0);
  totalCount.textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''}`;

  // Group by urgency
  const groups = [
    { label: 'Closing soon', items: active.filter((o) => daysUntil(o.returnDeadline) <= 3), },
    { label: 'This week', items: active.filter((o) => { const d = daysUntil(o.returnDeadline); return d > 3 && d <= 10; }) },
    { label: 'Later', items: active.filter((o) => daysUntil(o.returnDeadline) > 10) },
  ];

  groups.forEach(({ label, items }) => {
    if (items.length === 0) return;

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'section-label';
    sectionLabel.textContent = label;
    orderList.appendChild(sectionLabel);

    items.forEach((order) => {
      const days = daysUntil(order.returnDeadline);
      const level = urgencyLevel(days);
      const isRealOrderId = /^\d{3}-\d{7}-\d{7}$/.test(order.orderId);
      const itemObjs = order.items.length > 0 ? order.items : [{ title: 'Amazon Order', asin: null }];

      // Normalise — items may be strings (old format) or {title, asin} objects
      const normalised = itemObjs.map((i) => typeof i === 'string' ? { title: i, asin: null } : i);

      // Render one row per item, each with its own dot and badge
      normalised.forEach((item, idx) => {
        if (dismissed.has(dismissKey(order.orderId, item.title))) return;

        const itemHref = item.returnUrl || amazonItemUrl(order.orderId, item.asin);

        const row = document.createElement('div');
        row.className = 'order-item';

        const a = document.createElement('a');
        a.className = 'order-item-link';
        a.href = itemHref;
        a.target = '_blank';

        const dot = document.createElement('div');
        dot.className = `urgency-dot urgency-${level}`;

        const info = document.createElement('div');
        info.className = 'order-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'order-title';
        titleEl.textContent = item.title;

        const sub = document.createElement('div');
        sub.className = 'order-sub';
        sub.innerHTML = `Return by <strong>${formatDate(order.returnDeadline)}</strong>`;
        if (idx === 0 && isRealOrderId) {
          const idSpan = document.createElement('span');
          idSpan.className = 'order-id';
          idSpan.textContent = order.orderId;
          sub.append('  ', idSpan);
        }

        const badge = document.createElement('span');
        badge.className = `days-badge badge-${level}`;
        badge.textContent = daysLabel(days);

        info.append(titleEl, sub);
        a.append(dot, info, badge);

        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'dismiss-btn';
        dismissBtn.title = 'Not returning this';
        dismissBtn.textContent = '×';
        dismissBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const key = dismissKey(order.orderId, item.title);

          // Hide row immediately
          row.style.opacity = '0';
          row.style.transform = 'translateX(8px)';
          setTimeout(() => row.remove(), 200);

          // Show undo toast
          showUndoToast(item.title, () => {
            // Undo: remove key from dismissed list and re-render
            chrome.storage.local.get(['returnAlertOrders', 'returnAlertDismissed'], (r) => {
              const keys = (r.returnAlertDismissed || []).filter((k) => k !== key);
              chrome.storage.local.set({ returnAlertDismissed: keys }, () => {
                renderOrders(r.returnAlertOrders || [], new Set(keys));
              });
            });
          }, () => {
            // Confirmed: save to dismissed
            chrome.storage.local.get(['returnAlertDismissed'], (r) => {
              const keys = r.returnAlertDismissed || [];
              if (!keys.includes(key)) keys.push(key);
              chrome.storage.local.set({ returnAlertDismissed: keys });
            });
          });
        });

        row.appendChild(a);
        row.appendChild(dismissBtn);
        orderList.appendChild(row);
      });
    });
  });
}

let undoTimer = null;

function showUndoToast(title, onUndo, onConfirm) {
  const existing = document.getElementById('undo-toast');
  if (existing) existing.remove();
  if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }

  const toast = document.createElement('div');
  toast.id = 'undo-toast';
  const shortTitle = title.length > 28 ? title.slice(0, 28) + '…' : title;
  toast.innerHTML = `<span>Dismissed "${shortTitle}"</span><button id="undo-btn">Undo</button>`;
  document.body.appendChild(toast);

  document.getElementById('undo-btn').addEventListener('click', () => {
    toast.remove();
    clearTimeout(undoTimer);
    onUndo();
  });

  undoTimer = setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
    onConfirm();
  }, 4000);
}

chrome.storage.local.get(['returnAlertOrders', 'returnAlertDismissed'], (result) => {
  renderOrders(result.returnAlertOrders || [], new Set(result.returnAlertDismissed || []));
});

clearBtn.addEventListener('click', () => {
  chrome.storage.local.get(['returnAlertOrders'], (result) => {
    const orders = result.returnAlertOrders || [];
    const active = orders.filter((o) => daysUntil(o.returnDeadline) > 0);
    chrome.storage.local.set({ returnAlertOrders: active }, () => renderOrders(active));
  });
});

resetBtn.addEventListener('click', () => {
  chrome.storage.local.set({ returnAlertOrders: [], returnAlertDismissed: [] }, () => renderOrders([]));
});
