// These are Safari extension limits, separate from the App Store listing name.
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
