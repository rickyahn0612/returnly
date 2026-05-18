(async function () {
  // --- Core extraction logic — works on any parsed document ---
  function extractOrdersFromDoc(doc, baseUrl) {
    const orders = [];
    const containers = doc.querySelectorAll('[class*="order-card"], .order, .js-order-card, [id^="order-"]');
    const roots = containers.length > 0 ? Array.from(containers) : [doc.body];

    function resolveUrl(href) {
      if (!href) return null;
      try { return new URL(href, baseUrl).href; } catch { return null; }
    }

    function isJunkTitle(t) {
      if (!t || t.length < 8 || t.length > 200) return true;
      if (/^\$[\d.,]/.test(t)) return true;
      if (/^\([\$\d.,/a-z\s]+\)/i.test(t)) return true;
      if (/^\d+[\d.,\s%]*$/.test(t)) return true;
      if (/view product details|buy it again|add to cart|track package|return items|share gift|write a review|get product support|view order|view invoice|view your item/i.test(t)) return true;
      return false;
    }

    function isSameItem(a, b) {
      if (a.asin && b.asin) return a.asin === b.asin;
      const ta = a.title.toLowerCase().slice(0, 40);
      const tb = b.title.toLowerCase().slice(0, 40);
      return ta === tb || ta.startsWith(tb) || tb.startsWith(ta);
    }

    roots.forEach((container) => {
      const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (!text.includes('Eligible') && !text.includes('eligible')) continue;

        // Try the text node itself; fall back to parent's combined text for split-node HTML
        const parentText = node.parentElement
          ? node.parentElement.textContent.replace(/\s+/g, ' ').trim()
          : text;
        const match =
          text.match(/Eligible through\s+([A-Za-z]+ \d{1,2},?\s+\d{4})/i) ||
          parentText.match(/Eligible through\s+([A-Za-z]+ \d{1,2},?\s+\d{4})/i);
        if (!match) continue;

        const deadlineStr = match[1].replace(',', '');
        const returnDeadline = new Date(deadlineStr);
        if (isNaN(returnDeadline.getTime())) continue;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (returnDeadline < today) continue;

        // Walk up to find order container
        let el = node.parentElement;
        let orderContainer = null;
        for (let i = 0; i < 10; i++) {
          if (!el) break;
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

        // Find return URL
        let returnUrl = null;
        let el2 = node.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!el2) break;
          const retLink = el2.parentElement?.querySelector('a[href*="your-orders/pop"], a[href*="returns/homepage"]');
          if (retLink) {
            returnUrl = resolveUrl(retLink.getAttribute('href'));
            break;
          }
          el2 = el2.parentElement;
        }

        if (returnUrl) {
          const urlOrderId = returnUrl.match(/[?&]orderId=([\d\-]+)/)?.[1];
          if (urlOrderId) orderId = urlOrderId;
        }

        // Find item root — smallest container with exactly one /dp/ link
        let itemRoot = null;
        let candidate = node.parentElement;
        for (let i = 0; i < 12; i++) {
          if (!candidate) break;
          const dpLinks = candidate.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]');
          if (dpLinks.length === 1) { itemRoot = candidate; break; }
          if (dpLinks.length > 4) break;
          candidate = candidate.parentElement;
        }
        const searchRoot = itemRoot || orderContainer || doc.body;

        const items = [];

        // Strategy 1: /dp/ links with ASIN
        searchRoot.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})|\/gp\/product\/([A-Z0-9]{10})/);
          if (!asinMatch) return;
          const asin = asinMatch[1] || asinMatch[2];
          const title = Array.from(a.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent.trim())
            .join(' ').trim() || a.textContent.trim();
          if (isJunkTitle(title)) return;
          if (!items.find((i) => i.asin === asin)) items.push({ title, asin, returnUrl });
        });

        // Strategy 2: fallback
        if (items.length === 0) {
          for (const a of searchRoot.querySelectorAll('a')) {
            const title = a.textContent.trim();
            if (isJunkTitle(title)) continue;
            const href = a.getAttribute('href') || '';
            if (href.includes('order-history') || href.includes('your-orders')) continue;
            const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/);
            items.push({ title, asin: asinMatch ? asinMatch[1] : null, returnUrl });
            break;
          }
        }

        const existing = orders.find((o) => o.orderId === orderId);
        if (existing) {
          items.forEach((item) => {
            const dup = existing.items.find((e) => isSameItem(e, item));
            if (!dup) existing.items.push(item);
            else if (!dup.asin && item.asin) Object.assign(dup, item);
          });
        } else {
          orders.push({ orderId, returnDeadline: returnDeadline.toISOString(), items: [...items] });
        }
      }
    });

    return orders;
  }

  // --- Find all page URLs from pagination ---
  function getPageUrls() {
    const urls = new Set();
    const pageLinks = document.querySelectorAll('.a-pagination a, [class*="pagination"] a, a[href*="startIndex"]');
    pageLinks.forEach((a) => {
      const href = a.getAttribute('href');
      if (href && href.includes('startIndex')) {
        try { urls.add(new URL(href, location.href).href); } catch {}
      }
    });
    return [...urls];
  }

  // --- Save merged orders to storage ---
  function saveOrders(freshOrders) {
    return new Promise((resolve) => {
      chrome.storage.local.get(['returnAlertOrders'], (result) => {
        const stored = result.returnAlertOrders || [];
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const stillValid = stored.filter((o) => new Date(o.returnDeadline) >= today);
        const existingIds = new Set(stillValid.map((o) => o.orderId));

        const updated = stillValid.map((o) => {
          const fresh = freshOrders.find((n) => n.orderId === o.orderId);
          if (!fresh) return o;
          const merged = [...o.items];
          fresh.items.forEach((fi) => {
            if (!merged.find((e) => (e.asin && e.asin === fi.asin) || e.title === fi.title)) merged.push(fi);
          });
          return { ...o, items: merged };
        });

        const added = freshOrders.filter((o) => !existingIds.has(o.orderId));
        const merged = [...updated, ...added];

        chrome.storage.local.set({ returnAlertOrders: merged }, () => {
          const today2 = new Date();
          today2.setHours(0, 0, 0, 0);
          const expiringSoon = merged.filter((o) => {
            const d = Math.ceil((new Date(o.returnDeadline) - today2) / 86400000);
            return d >= 0 && d <= 7;
          });
          chrome.runtime.sendMessage({ type: 'UPDATE_BADGE', count: expiringSoon.length });
          resolve(merged);
        });
      });
    });
  }

  function showToast(msg) {
    const existing = document.getElementById('returnly-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'returnly-toast';
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: '#f97316', color: 'white', padding: '10px 16px',
      borderRadius: '8px', fontSize: '13px', fontWeight: '600',
      zIndex: '999999', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
      transition: 'opacity 0.4s',
    });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 4500);
    setTimeout(() => toast.remove(), 5000);
  }

  // --- Background scan tab: just extract and report, then stop ---
  if (new URLSearchParams(location.search).has('_rt')) {
    const orders = extractOrdersFromDoc(document, location.href);
    chrome.runtime.sendMessage({ type: 'PAGE_SCAN_RESULT', orders });
    return;
  }

  // --- Main flow (user-visible page) ---
  showToast('ReturnAlert: scanning your orders…');

  const currentOrders = extractOrdersFromDoc(document, location.href);
  const otherPageUrls = getPageUrls();

  if (otherPageUrls.length === 0) {
    const saved = await saveOrders(currentOrders);
    const itemCount = saved.reduce((sum, o) => sum + Math.max(o.items.length, 1), 0);
    showToast(`ReturnAlert: found ${itemCount} item${itemCount !== 1 ? 's' : ''}`);
    return;
  }

  // Background will open each page as a real tab, extract, and send SCAN_COMPLETE
  showToast(`ReturnAlert: scanning ${1 + otherPageUrls.length} pages…`);

  const allOrders = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve(currentOrders); // fallback: just use page 1 results
    }, 45000);

    const listener = (msg) => {
      if (msg.type !== 'SCAN_COMPLETE') return;
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timeout);
      resolve(msg.orders);
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.runtime.sendMessage({ type: 'SCAN_PAGES', urls: otherPageUrls, currentOrders });
  });

  const saved = await saveOrders(allOrders);
  const itemCount = saved.reduce((sum, o) => sum + Math.max(o.items.length, 1), 0);
  const pageCount = 1 + otherPageUrls.length;
  showToast(`ReturnAlert: found ${itemCount} item${itemCount !== 1 ? 's' : ''} across ${pageCount} page${pageCount !== 1 ? 's' : ''}`);
})();
