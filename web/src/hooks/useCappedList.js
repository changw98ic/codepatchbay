import { useState, useCallback, useEffect } from 'react';

export default function useCappedList(items, options = {}) {
  const { cap = 5, selectedKey, keyFn, deps = [] } = options;
  const [showAll, setShowAll] = useState(false);
  const toggle = useCallback(() => setShowAll((v) => !v), []);

  useEffect(() => { setShowAll(false); }, deps);

  if (!items || items.length === 0) {
    return { displayed: [], showAll, toggle, hasMore: false };
  }

  const hasMore = items.length > cap;
  if (showAll || !hasMore) {
    return { displayed: items, showAll, toggle, hasMore };
  }

  let displayed = items.slice(0, cap);
  if (selectedKey != null) {
    const resolveKey = keyFn || ((item) => item?.id ?? item);
    const inView = displayed.some((item) => resolveKey(item) === selectedKey);
    if (!inView) {
      const selected = items.find((item) => resolveKey(item) === selectedKey);
      if (selected) {
        displayed = [...displayed.slice(0, cap - 1), selected];
      }
    }
  }

  return { displayed, showAll, toggle, hasMore };
}
