// Safari can focus the first link when opening a popover. Discard only that
// automatic focus; genuine keyboard/pointer focus keeps its visible indicator.
let popupInteracted = false;
document.addEventListener('keydown', () => { popupInteracted = true; }, true);
document.addEventListener('pointerdown', () => { popupInteracted = true; }, true);
function clearAutomaticActionFocus() {
  if (!popupInteracted && document.activeElement?.classList.contains('safari-action')) {
    document.activeElement.blur();
  }
}
document.addEventListener('focusin', clearAutomaticActionFocus);
document.addEventListener('DOMContentLoaded', () => {
  clearAutomaticActionFocus();
  const rate = document.getElementById('apple-rate');
  rate.addEventListener('click', event => {
    if (!rate.hasAttribute('href')) {
      event.preventDefault();
      showToast(chrome.i18n.getMessage('ratingUnavailable'));
    } else if (rate.dataset.unpublished === 'true') {
      showToast(chrome.i18n.getMessage('ratingUnavailable'));
    }
  });
  rate.addEventListener('keydown', event => {
    if (event.key === ' ' || (event.key === 'Enter' && !rate.hasAttribute('href'))) {
      event.preventDefault();
      rate.click();
    }
  });
});
