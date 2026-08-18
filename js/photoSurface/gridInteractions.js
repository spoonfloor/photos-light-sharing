/**
 * Shared grid click routing (selection, star, lightbox).
 */
const GridInteractions = (() => {
  function parsePhotoId(card) {
    const raw = card?.dataset?.id;
    if (raw == null || raw === '') {
      return null;
    }
    const asNumber = Number(raw);
    return Number.isFinite(asNumber) && String(asNumber) === raw ? asNumber : raw;
  }

  function handleCardClick(ctx, card, event) {
    const photoId = parsePhotoId(card);
    if (photoId == null) {
      return;
    }

    const selectCircle = card.querySelector('.select-circle');
    const clickedSelectCircle =
      selectCircle &&
      (event.target === selectCircle || selectCircle.contains(event.target));

    const selectedCount = ctx.getSelectedCount?.() ?? 0;

    if (selectedCount > 0) {
      if (
        ctx.isSelected?.(photoId) &&
        !event.shiftKey &&
        !clickedSelectCircle
      ) {
        ctx.onOpenLightbox?.(photoId);
        return;
      }
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.stopPropagation();
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    if (clickedSelectCircle) {
      event.stopPropagation();
      ctx.onToggleSelection?.(photoId, { event, card });
      return;
    }

    ctx.onOpenLightbox?.(photoId);
  }

  function wireContainer(container, ctx) {
    if (!container || container.dataset.gridInteractionsWired === 'true') {
      return;
    }

    container.addEventListener('click', (event) => {
      const monthCircle = event.target.closest('.month-select-circle');
      if (monthCircle && container.contains(monthCircle)) {
        event.stopPropagation();
        event.preventDefault();
        ctx.onMonthCircleClick?.(monthCircle, event);
        return;
      }

      const starBadge = event.target.closest('.star-badge');
      if (starBadge && container.contains(starBadge)) {
        if (starBadge.classList.contains('star-badge--readonly')) {
          return;
        }
        event.stopPropagation();
        event.preventDefault();
        const caps = ctx.getCapabilities?.();
        if (caps?.gridStarBadge !== 'interactive') {
          return;
        }
        const photoId = parsePhotoId(starBadge.closest('.photo-card'));
        if (photoId != null) {
          ctx.onToggleStar?.(photoId);
        }
        return;
      }

      const card = event.target.closest('.photo-card');
      if (card && container.contains(card)) {
        handleCardClick(ctx, card, event);
      }
    });

    container.dataset.gridInteractionsWired = 'true';
  }

  return {
    wireContainer,
    handleCardClick,
    parsePhotoId,
  };
})();
