/**
 * Non-virtual month-grouped grid renderer (share viewer + library fallback).
 */
const SimplePhotoGrid = (() => {
  function monthKey(date) {
    return MonthGrid.monthKeyFromDate(date);
  }

  function monthHeaderLabel(date) {
    return MonthGrid.monthLabel(monthKey(date));
  }

  function render(container, photos, ctx) {
    if (!container) {
      return;
    }

    container.innerHTML = '';
    const caps = ctx.getCapabilities?.() ?? ViewCapabilities.get();

    if (!photos.length) {
      if (ctx.interactionCtx && typeof GridInteractions !== 'undefined') {
        GridInteractions.wireContainer(container, ctx.interactionCtx);
      }
      ctx.onAfterRender?.(photos);
      return;
    }

    let currentKey = null;
    let gridEl = null;

    photos.forEach((photo, index) => {
      const date = ctx.parseDate?.(photo.date_taken) ?? null;
      const key = monthKey(date);
      if (key !== currentKey) {
        currentKey = key;
        const section = MonthGrid.createMonthSection(key);
        gridEl = section.gridEl;
        container.appendChild(section.sectionEl);
      }

      const card = GridTile.createCard({
        caps,
        photoId: photo.id,
        favorited: ctx.isStarred?.(photo) ?? false,
        isVideo: photo.file_type === 'video',
        selected: ctx.isSelected?.(photo.id) ?? false,
        thumbSrc: ctx.thumbUrl?.(photo) ?? null,
        thumbAlt: photo.original_filename || 'Photo',
        index,
      });

      GridTile.attachThumbLoadHandler(card.querySelector('.photo-thumb'));
      gridEl.appendChild(card);
    });

    if (typeof GridSelection !== 'undefined' && ctx.getSelectedIds) {
      GridSelection.applyToDom(container, ctx.getSelectedIds());
    }

    if (ctx.interactionCtx && typeof GridInteractions !== 'undefined') {
      GridInteractions.wireContainer(container, ctx.interactionCtx);
    }

    ctx.onAfterRender?.(photos);
  }

  return {
    monthKey,
    monthHeaderLabel,
    render,
  };
})();
