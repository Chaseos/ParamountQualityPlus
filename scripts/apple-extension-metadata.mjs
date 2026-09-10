// These are Safari extension limits, separate from the App Store listing name.
export function validateAppleTipMetadata(products) {
  if (products.some(p => !p.name?.trim() || p.name.length > 30 || !p.description?.trim() || p.description.length > 45 || !/^\d+\.\d{2}$/.test(p.priceUSD))) {
    throw Error('Invalid consumable metadata: names must fit 30 characters and descriptions 45');
  }
}

export function validateSafariManifestText(manifest, messages, locale) {
  for (const [field, limit] of [['name', 40], ['description', 112]]) {
    const value = manifest[field];
    const key = typeof value === 'string' && value.match(/^__MSG_(.+)__$/)?.[1];
    const text = key ? messages?.[key]?.message : value;
    if (typeof text !== 'string' || !text.trim() || text.length > limit) {
      throw Error(`Safari ${locale}: ${field} must resolve to a nonempty string of ${limit} or fewer characters`);
    }
  }
}
