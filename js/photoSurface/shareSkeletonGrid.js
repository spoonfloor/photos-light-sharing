/**
 * Generic gray skeleton grid for share meta-first boot (title + first month known).
 */
const ShareSkeletonGrid = (() => {
  function monthKeyFromDateTaken(dateTaken) {
    if (!dateTaken) {
      return 'undated';
    }
    const date = new Date(dateTaken);
    if (Number.isNaN(date.getTime())) {
      return 'undated';
    }
    return MonthGrid.monthKeyFromDate(date);
  }

  function render(container, { monthKey = 'undated', cellCount = 0 } = {}) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const count = Math.max(0, Number(cellCount) || 0);
    if (count === 0) {
      return;
    }

    const section = MonthGrid.createMonthSection(monthKey, {
      extraSectionClasses: ['share-skeleton-section'],
    });
    const gridEl = section.gridEl;

    for (let i = 0; i < count; i += 1) {
      const card = document.createElement('div');
      card.className = 'photo-card virtual-placeholder-card share-skeleton-card';
      card.dataset.skeletonIndex = String(i);
      gridEl.appendChild(card);
    }

    container.appendChild(section.sectionEl);
  }

  return {
    monthKeyFromDateTaken,
    render,
  };
})();
