// Scrapes Amazon order pages for return eligibility dates

(function () {
  const orders = [];

  // Amazon shows "Return or replace items: Eligible through June 10, 2026"
  // or "Return items: Eligible through June 10, 2026"
  // Walk every order card and find these strings directly
  const orderCards = document.querySelectorAll('[class*="order-card"], .order, .js-order-card, [id^="order-"]');

  // Fallback: scan the whole page if card selectors don't match
  const containers = orderCards.length > 0 ? Array.from(orderCards) : [document.body];

  containers.forEach((container) => {
    // Find "Eligible through" text nodes
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      const match = text.match(/Eligible through\s+([A-Za-z]+ \d{1,2},?\s+\d{4})/i);
      if (!match) continue;

      const deadlineStr = match[1].replace(',', '');
      const returnDeadline = new Date(deadlineStr);
      if (isNaN(returnDeadline.getTime())) continue;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (returnDeadline < today) continue;

      // Walk up to find the order container and extract item title + order ID
      let el = node.parentElement;
      let orderContainer = null;
      for (let i = 0; i < 10; i++) {
        if (!el) break;
        // Amazon order cards have ORDER # in them
        if (el.textContent.includes('ORDER #') || el.textContent.includes('Order #')) {
          orderContainer = el;
          break;
        }
        el = el.parentElement;
      }

      // Extract order ID
      let orderId = `returnly-${returnDeadline.toISOString()}`;
      if (orderContainer) {
        const idMatch = orderContainer.textContent.match(/ORDER\s*#\s*([\d\-]+)/i);
        if (idMatch) orderId = idMatch[1].trim();
      }

      // Find the "Return items" link right above "Eligible through" — it has the full return URL
      let returnUrl = null;
      let el2 = node.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!el2) break;
        const retLink = el2.parentElement?.querySelector('a[href*="your-orders/pop"], a[href*="returns/homepage"]');
        if (retLink) { returnUrl = retLink.href; break; }
        el2 = el2.parentElement;
      }

      // Also try to extract the real orderId from the return URL
      if (returnUrl) {
        const urlOrderId = returnUrl.match(/[?&]orderId=([\d\-]+)/)?.[1];
        if (urlOrderId) orderId = urlOrderId;
      }

      // Extract item title — try multiple strategies
      const items = [];

      // Walk UP from "Eligible through" node to find the smallest container
      // that has exactly one /dp/ product link — that's the item row, not the whole order
      let itemRoot = null;
      let candidate = node.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!candidate) break;
        const dpLinks = candidate.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
        if (dpLinks.length === 1) { itemRoot = candidate; break; }
        if (dpLinks.length > 4) break; // gone too wide, stop
        candidate = candidate.parentElement;
      }
      const searchRoot = itemRoot || orderContainer || document.body;

      function isJunkTitle(t) {
        if (!t || t.length < 8 || t.length > 200) return true;
        if (/^\$[\d.,]/.test(t)) return true;           // price like $9.99
        if (/^\([\$\d.,/a-z\s]+\)/i.test(t)) return true; // unit price like ($2.50/count)
        if (/^\d+[\d.,\s%]*$/.test(t)) return true;    // pure numbers
        if (/view product details|buy it again|add to cart|track package|return items|share gift|write a review|get product support|view order|view invoice/i.test(t)) return true;
        return false;
      }

      // Strategy 1: product page links — must have /dp/ ASIN and clean text
      const productLinks = searchRoot.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
      productLinks.forEach((a) => {
        const asinMatch = a.href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/);
        if (!asinMatch) return;
        const asin = asinMatch[1] || asinMatch[2];
        // Use only the direct text of the link, not nested price spans
        const title = Array.from(a.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.trim())
          .join(' ').trim() || a.textContent.trim();
        if (isJunkTitle(title)) return;
        if (!items.find((i) => i.asin === asin)) items.push({ title, asin, returnUrl });
      });

      // Strategy 2: fallback for non-standard links only if Strategy 1 found nothing
      if (items.length === 0) {
        const allLinks = searchRoot.querySelectorAll('a');
        for (const a of allLinks) {
          const title = a.textContent.trim();
          if (isJunkTitle(title)) continue;
          const href = a.href || '';
          if (href.includes('order-history') || href.includes('your-orders')) continue;
          const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
          const asin = asinMatch ? asinMatch[1] : null;
          items.push({ title, asin, returnUrl });
          break; // one fallback item only
        }
      }

      function isSameItem(a, b) {
        if (a.asin && b.asin) return a.asin === b.asin;
        const ta = a.title.toLowerCase().slice(0, 40);
        const tb = b.title.toLowerCase().slice(0, 40);
        return ta === tb || ta.startsWith(tb) || tb.startsWith(ta);
      }

      const existing = orders.find((o) => o.orderId === orderId);
      if (existing) {
        items.forEach((item) => {
          const dup = existing.items.find((e) => isSameItem(e, item));
          if (!dup) {
            existing.items.push(item);
          } else if (!dup.asin && item.asin) {
            // Upgrade to version with ASIN
            Object.assign(dup, item);
          }
        });
      } else {
        orders.push({
          orderId,
          returnDeadline: returnDeadline.toISOString(),
          items: [...items],
        });
      }
    }
  });

  if (orders.length > 0) {
    chrome.storage.local.get(['returnlyOrders'], (result) => {
      const existing = result.returnlyOrders || [];
      const existingIds = new Set(existing.map((o) => o.orderId));

      // Remove expired orders, add new ones
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const stillValid = existing.filter((o) => new Date(o.returnDeadline) >= today);
      const newOrders = orders.filter((o) => !existingIds.has(o.orderId));
      // Overwrite stored entries with fresh scraped data, merging items
      const updated = stillValid.map((o) => {
        const fresh = orders.find((n) => n.orderId === o.orderId);
        if (!fresh) return o;
        const merged = [...o.items];
        fresh.items.forEach((fi) => {
          const key = typeof fi === 'string' ? fi : fi.title;
          if (!merged.find((e) => (typeof e === 'string' ? e : e.title) === key)) merged.push(fi);
        });
        return { ...o, items: merged };
      });
      const merged = [...updated, ...newOrders];

      chrome.storage.local.set({ returnlyOrders: merged }, () => {
        // Update badge immediately
        const expiringSoon = merged.filter((o) => {
          const days = Math.ceil((new Date(o.returnDeadline) - today) / (1000 * 60 * 60 * 24));
          return days > 0 && days <= 7;
        });
        chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: expiringSoon.length });

        // Show a small toast so user knows it ran
        const itemCount = merged.reduce((sum, o) => sum + Math.max(o.items.length, 1), 0);
        showToast(`Returnly: tracking ${itemCount} item${itemCount !== 1 ? 's' : ''} across ${merged.length} order${merged.length !== 1 ? 's' : ''}`);
      });
    });
  } else {
    showToast('Returnly: no return windows found on this page');
  }

  function showToast(msg) {
    const existing = document.getElementById('returnly-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'returnly-toast';
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      background: '#f97316',
      color: 'white',
      padding: '10px 16px',
      borderRadius: '8px',
      fontSize: '13px',
      fontWeight: '600',
      zIndex: '999999',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      transition: 'opacity 0.4s',
    });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
    setTimeout(() => toast.remove(), 3500);
  }
})();
