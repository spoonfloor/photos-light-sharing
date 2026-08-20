/**
 * Share viewer month/year jumper — eager day-cluster grid (non-virtual).
 */
const ShareDatePicker = (() => {
  const APP_BAR_OFFSET = 80;

  let wired = false;
  let updatingFromScroll = false;
  let lastSyncedMonthKey = null;
  let scrollRaf = null;
  let availableMonths = [];
  let getSortOrder = () => 'oldest';

  function isCalendarMonthKey(monthKey) {
    return typeof monthKey === 'string' && /^\d{4}-\d{2}$/.test(monthKey);
  }

  function monthKeyFromDayKey(dayKey) {
    if (!dayKey || dayKey === 'undated') {
      return 'undated';
    }
    return dayKey.slice(0, 7);
  }

  function monthOrdinal(monthKey) {
    const [year, month] = monthKey.split('-');
    return parseInt(year, 10) * 12 + parseInt(month, 10);
  }

  function nearestMonthInIndex(targetMonth, months, sortOrder = 'oldest') {
    if (!targetMonth || !months?.length) {
      return null;
    }

    const catalog = months.filter((monthKey) => monthKey && monthKey !== 'undated');
    if (!catalog.length) {
      return null;
    }
    if (catalog.includes(targetMonth)) {
      return targetMonth;
    }

    const targetYear = targetMonth.slice(0, 4);
    const targetMonthNum = parseInt(targetMonth.slice(5, 7), 10);
    const yearMonths = catalog
      .filter((monthKey) => monthKey.slice(0, 4) === targetYear)
      .sort((a, b) => a.localeCompare(b));

    if (yearMonths.length) {
      if (sortOrder === 'newest') {
        const candidates = yearMonths.filter(
          (monthKey) => parseInt(monthKey.slice(5, 7), 10) >= targetMonthNum,
        );
        return candidates.length ? candidates[0] : yearMonths[yearMonths.length - 1];
      }
      const candidates = yearMonths.filter(
        (monthKey) => parseInt(monthKey.slice(5, 7), 10) <= targetMonthNum,
      );
      return candidates.length ? candidates[candidates.length - 1] : yearMonths[0];
    }

    const targetOrdinal = monthOrdinal(targetMonth);
    let bestMonth = catalog[0];
    let bestDistance = Infinity;
    catalog.forEach((monthKey) => {
      const distance = Math.abs(monthOrdinal(monthKey) - targetOrdinal);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestMonth = monthKey;
      }
    });
    return bestMonth;
  }

  function yearsFromPhotos(photos, parseDate) {
    const years = new Set();
    for (const photo of photos) {
      const date = parseDate?.(photo.date_taken);
      if (date) {
        years.add(date.getFullYear());
      }
    }
    return [...years].sort((a, b) => a - b);
  }

  function monthsFromPhotos(photos, parseDate) {
    const months = new Set();
    for (const photo of photos) {
      const date = parseDate?.(photo.date_taken);
      if (date) {
        months.add(MonthGrid.monthKeyFromDate(date));
      }
    }
    return [...months].sort((a, b) => a.localeCompare(b));
  }

  function orderedYears(years) {
    if (getSortOrder() === 'newest') {
      return [...years].reverse();
    }
    return years;
  }

  function setYearStaticMode(yearPicker, isStatic) {
    yearPicker.classList.toggle('date-picker-select--static', isStatic);
    yearPicker.tabIndex = isStatic ? -1 : 0;
    yearPicker.setAttribute('aria-disabled', isStatic ? 'true' : 'false');
  }

  function populateYearPicker(years) {
    const yearPicker = document.getElementById('yearPicker');
    if (!yearPicker || !years.length) {
      return yearPicker;
    }

    const sorted = orderedYears(years);
    yearPicker.innerHTML = '';
    sorted.forEach((year) => {
      const option = document.createElement('option');
      option.value = String(year);
      option.textContent = String(year);
      yearPicker.appendChild(option);
    });

    setYearStaticMode(yearPicker, sorted.length === 1);
    return yearPicker;
  }

  function applyMonthDisabledState(year) {
    const monthPicker = document.getElementById('monthPicker');
    if (!monthPicker) {
      return;
    }

    if (!availableMonths.length) {
      for (const option of monthPicker.options) {
        option.disabled = false;
      }
      return;
    }

    const activeMonthsInYear = new Set(
      availableMonths
        .filter((monthKey) => monthKey.slice(0, 4) === String(year))
        .map((monthKey) => parseInt(monthKey.slice(5, 7), 10)),
    );
    const hasAnyInYear = activeMonthsInYear.size > 0;

    for (const option of monthPicker.options) {
      const monthNum = parseInt(option.value, 10);
      option.disabled = hasAnyInYear && !activeMonthsInYear.has(monthNum);
    }
  }

  function setPickerValues(monthKey) {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker || !isCalendarMonthKey(monthKey)) {
      return;
    }

    const [year, month] = monthKey.split('-');
    updatingFromScroll = true;
    yearPicker.value = year;
    monthPicker.value = String(parseInt(month, 10));
    applyMonthDisabledState(year);
    lastSyncedMonthKey = monthKey;
    requestAnimationFrame(() => {
      updatingFromScroll = false;
    });
  }

  function revealDatePicker() {
    const datePickerContainer = document.querySelector('.date-picker');
    if (!datePickerContainer) {
      return;
    }
    datePickerContainer.style.visibility = 'visible';
    datePickerContainer.removeAttribute('aria-hidden');
  }

  function applyAnchorMonth(anchorMonthKey) {
    if (!isCalendarMonthKey(anchorMonthKey)) {
      return;
    }
    setPickerValues(anchorMonthKey);
  }

  function applyFromMeta(firstCluster, sortOrder) {
    if (sortOrder) {
      getSortOrder = () => sortOrder;
    }

    const monthKey =
      firstCluster?.month_key ?? monthKeyFromDayKey(firstCluster?.day_key);
    if (!isCalendarMonthKey(monthKey)) {
      return;
    }

    const year = parseInt(monthKey.slice(0, 4), 10);
    populateYearPicker([year]);
    applyAnchorMonth(monthKey);
    revealDatePicker();
  }

  function applyFromPhotos(photos, parseDate, sortOrder, anchorMonthKey = null) {
    if (sortOrder) {
      getSortOrder = () => sortOrder;
    }

    availableMonths = monthsFromPhotos(photos, parseDate);
    const years = yearsFromPhotos(photos, parseDate);
    if (!years.length) {
      return;
    }

    const yearPicker = populateYearPicker(years);
    if (!yearPicker) {
      return;
    }

    const anchor =
      anchorMonthKey && isCalendarMonthKey(anchorMonthKey)
        ? anchorMonthKey
        : availableMonths[0] ?? `${years[0]}-01`;
    const resolved = nearestMonthInIndex(anchor, availableMonths, getSortOrder()) || anchor;
    setPickerValues(resolved);

    const monthPicker = document.getElementById('monthPicker');
    if (monthPicker) {
      monthPicker.disabled = false;
      monthPicker.classList.remove('surface-layout-placeholder');
    }
    if (yearPicker) {
      yearPicker.classList.remove('surface-layout-placeholder');
    }
    revealDatePicker();
  }

  function refreshCatalog(photos, parseDate) {
    availableMonths = monthsFromPhotos(photos, parseDate);
    const years = yearsFromPhotos(photos, parseDate);
    if (!years.length) {
      return;
    }

    populateYearPicker(years);

    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return;
    }

    const current = `${yearPicker.value}-${monthPicker.value.padStart(2, '0')}`;
    const resolved =
      nearestMonthInIndex(current, availableMonths, getSortOrder()) || availableMonths[0];
    if (resolved) {
      setPickerValues(resolved);
    } else {
      applyMonthDisabledState(yearPicker.value);
    }
  }

  function scrollToMonthSection(monthKey) {
    if (!isCalendarMonthKey(monthKey)) {
      return false;
    }

    const sections = document.querySelectorAll('.month-section[data-month]');
    for (const section of sections) {
      const clusterKey = section.dataset.month;
      if (clusterKey === monthKey || clusterKey.startsWith(`${monthKey}-`)) {
        const targetY = section.offsetTop - APP_BAR_OFFSET;
        window.scrollTo({ top: Math.max(0, targetY), behavior: 'instant' });
        return true;
      }
    }
    return false;
  }

  function monthFromScroll() {
    let bestMonth = null;
    let bestTop = -Infinity;

    document.querySelectorAll('.month-section[data-month]').forEach((section) => {
      const clusterKey = section.dataset.month;
      const monthKey = monthKeyFromDayKey(clusterKey);
      if (!isCalendarMonthKey(monthKey)) {
        return;
      }
      const top = section.getBoundingClientRect().top;
      if (top <= APP_BAR_OFFSET && top > bestTop) {
        bestTop = top;
        bestMonth = monthKey;
      }
    });

    if (bestMonth) {
      return bestMonth;
    }

    let firstBelow = null;
    let firstBelowTop = Infinity;
    document.querySelectorAll('.month-section[data-month]').forEach((section) => {
      const clusterKey = section.dataset.month;
      const monthKey = monthKeyFromDayKey(clusterKey);
      if (!isCalendarMonthKey(monthKey)) {
        return;
      }
      const top = section.getBoundingClientRect().top;
      if (top > APP_BAR_OFFSET && top < firstBelowTop) {
        firstBelowTop = top;
        firstBelow = monthKey;
      }
    });

    return firstBelow;
  }

  function syncFromScroll() {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker || monthPicker.disabled) {
      return;
    }

    const monthKey = monthFromScroll();
    if (!monthKey || monthKey === lastSyncedMonthKey) {
      return;
    }

    setPickerValues(monthKey);
  }

  function scheduleSyncFromScroll() {
    if (scrollRaf) {
      return;
    }
    scrollRaf = window.requestAnimationFrame(() => {
      scrollRaf = null;
      syncFromScroll();
    });
  }

  function coSelectForYearChange() {
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return null;
    }

    const year = yearPicker.value;
    const monthNum = parseInt(monthPicker.value, 10);
    const preferred = `${year}-${String(monthNum).padStart(2, '0')}`;

    if (!availableMonths.length) {
      applyMonthDisabledState(year);
      return preferred;
    }

    const resolved =
      nearestMonthInIndex(preferred, availableMonths, getSortOrder()) || preferred;
    setPickerValues(resolved);
    return resolved;
  }

  function handleMonthChange() {
    if (updatingFromScroll) {
      return;
    }
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return;
    }
    const month = monthPicker.value.padStart(2, '0');
    const monthKey = `${yearPicker.value}-${month}`;
    scrollToMonthSection(monthKey);
    lastSyncedMonthKey = monthKey;
  }

  function handleYearChange() {
    if (updatingFromScroll) {
      return;
    }
    const yearPicker = document.getElementById('yearPicker');
    if (yearPicker?.classList.contains('date-picker-select--static')) {
      return;
    }
    const targetMonth = coSelectForYearChange();
    if (targetMonth) {
      scrollToMonthSection(targetMonth);
    }
  }

  function wire({ sortOrderGetter } = {}) {
    if (sortOrderGetter) {
      getSortOrder = sortOrderGetter;
    }

    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (!monthPicker || !yearPicker) {
      return;
    }

    if (!wired) {
      wired = true;
      monthPicker.addEventListener('change', handleMonthChange);
      yearPicker.addEventListener('change', handleYearChange);
      window.addEventListener('scroll', scheduleSyncFromScroll, { passive: true });
    }
  }

  function afterGridRender() {
    lastSyncedMonthKey = null;
    scheduleSyncFromScroll();
  }

  function setSortOrder(sortOrder) {
    getSortOrder = () => sortOrder;
    if (!availableMonths.length) {
      return;
    }
    const years = [...new Set(availableMonths.map((monthKey) => monthKey.slice(0, 4)))].map(
      (year) => parseInt(year, 10),
    );
    years.sort((a, b) => a - b);
    populateYearPicker(years);
    const monthPicker = document.getElementById('monthPicker');
    const yearPicker = document.getElementById('yearPicker');
    if (monthPicker && yearPicker) {
      const current = `${yearPicker.value}-${monthPicker.value.padStart(2, '0')}`;
      const resolved =
        nearestMonthInIndex(current, availableMonths, getSortOrder()) || availableMonths[0];
      if (resolved) {
        setPickerValues(resolved);
      }
    }
  }

  return {
    applyFromMeta,
    applyFromPhotos,
    refreshCatalog,
    wire,
    afterGridRender,
    setSortOrder,
    syncFromScroll,
  };
})();
