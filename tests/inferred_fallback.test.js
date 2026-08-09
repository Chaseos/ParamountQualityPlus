import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  getInferredMaxCandidate,
  recordInferredFallbackResult,
  resetInferredFallbackState
} from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const SEGMENT_URL = 'https://vod.pplus.paramount.tech/intl_vms/title/asset_cenc_precon_dash/PPUSA_MOVIE_UHD_V1_c24_540p_4309720_2000/seg_56.m4s?CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812';
const LEGACY_CBS_SEGMENT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/title/asset_cenc_precon_dash/WOLF_OF_WALL_STREET_c24_540p_3054956_2000/seg_5.m4s?CMCD=br%3D1969%2Cot%3Dv%2Ctb%3D5583';
const LEGACY_CBS_PLAIN_TIER_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/title/asset_cenc_precon_dash/Sleepy_Hollow_FTR_VMASTER_2725014_2100/seg_6.m4s?CMCD=br%3D2738%2Cot%3Dv%2Ctb%3D5880';
const CLASSIC_TV_PLAIN_TIER_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/title/asset_cenc_precon_dash/CBS_STAR_TREK_REM_S01E00_THE_CAGE_1236221_2100/seg_4.m4s?CMCD=br%3D2732%2Cot%3Dv%2Ctb%3D5887';
const PARAMOUNT_PLAIN_TIER_URL = 'https://vod.pplus.paramount.tech/intl_vms/title/asset_cenc_precon_dash/NICKELODEON_SPONGEBOBSQUAREPANTSHD_001_V1_917732_2100/seg_4.m4s?CMCD=br%3D2729%2Cot%3Dv%2Ctb%3D5698';
const NICKELODEON_HD_SEGMENT_URL = 'https://vod.pplus.paramount.tech/intl_vms/title/asset_cenc_precon_dash/NICKELODEON_SPONGEBOBSQUAREPANTS_307_HD_c24_540p_3480060_2000/seg_4.m4s?CMCD=br%3D1961%2Cot%3Dv%2Ctb%3D5387';
const NUMERIC_PREFIX_SEGMENT_URL = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/title/asset_cenc_precon_dash/3478685_c24_540p_118423_2000/seg_4.m4s?CMCD=br%3D2011%2Cot%3Dv%2Ctb%3D5585';
const LEGACY_CBS_VOD_HOST = 'vod-gcs-cedexis.cbsaavideo.com';

describe('Inferred Paramount VOD fallback', () => {
  beforeEach(() => {
    setRepresentations([]);
    setConfig({ forceMax: true, forcedId: null });
    resetInferredFallbackState();
  });

  test('builds the verified 1080p candidate and preserves CMCD', () => {
    const candidate = getInferredMaxCandidate(SEGMENT_URL);

    expect(candidate.needsValidation).toBe(true);
    expect(candidate.source).toBe('inferred');
    expect(candidate.url).toContain('PPUSA_MOVIE_UHD_V1_c20_1080p_4309720_5400/seg_56.m4s');
    expect(candidate.url).toContain('CMCD=br%3D1802%2Cot%3Dv%2Ctb%3D5812');
  });

  test('uses the verified c23 ladder for the legacy CBS VOD host', () => {
    const candidate = getInferredMaxCandidate(LEGACY_CBS_SEGMENT_URL);

    expect(candidate.needsValidation).toBe(true);
    expect(candidate.url).toContain('WOLF_OF_WALL_STREET_c23_1080p_3054956_5400/seg_5.m4s');
    expect(candidate.url).toContain('CMCD=br%3D1969%2Cot%3Dv%2Ctb%3D5583');
  });

  test('uses the verified 4500 tier for legacy CBS paths without quality markers', () => {
    const candidate = getInferredMaxCandidate(LEGACY_CBS_PLAIN_TIER_URL);

    expect(candidate.needsValidation).toBe(true);
    expect(candidate.url).toContain('Sleepy_Hollow_FTR_VMASTER_2725014_4500/seg_6.m4s');
    expect(candidate.url).toContain('CMCD=br%3D2738%2Cot%3Dv%2Ctb%3D5880');
  });

  test('recognizes plain tiers without mastering markers and on the Paramount CDN', () => {
    expect(getInferredMaxCandidate(CLASSIC_TV_PLAIN_TIER_URL).url)
      .toContain('CBS_STAR_TREK_REM_S01E00_THE_CAGE_1236221_4500/seg_4.m4s');

    resetInferredFallbackState();
    expect(getInferredMaxCandidate(PARAMOUNT_PLAIN_TIER_URL).url)
      .toContain('NICKELODEON_SPONGEBOBSQUAREPANTSHD_001_V1_917732_4500/seg_4.m4s');
  });

  test('selects c23 for HD pipelines but keeps numeric CBS prefixes on c20', () => {
    expect(getInferredMaxCandidate(NICKELODEON_HD_SEGMENT_URL).url)
      .toContain('NICKELODEON_SPONGEBOBSQUAREPANTS_307_HD_c23_1080p_3480060_5400');

    resetInferredFallbackState();
    expect(getInferredMaxCandidate(NUMERIC_PREFIX_SEGMENT_URL).url)
      .toContain('3478685_c20_1080p_118423_5400');
  });

  test('reuses a validated stream and suppresses a rejected stream', () => {
    const candidate = getInferredMaxCandidate(SEGMENT_URL);
    recordInferredFallbackResult(candidate.streamKey, true);
    expect(getInferredMaxCandidate(SEGMENT_URL).needsValidation).toBe(false);

    recordInferredFallbackResult(candidate.streamKey, false);
    expect(getInferredMaxCandidate(SEGMENT_URL)).toBeNull();
  });

  test('resets inference when the stream identity changes', () => {
    const first = getInferredMaxCandidate(SEGMENT_URL);
    recordInferredFallbackResult(first.streamKey, false);

    const nextStream = SEGMENT_URL.replace('asset_cenc_precon_dash', 'other_cenc_precon_dash');
    expect(getInferredMaxCandidate(nextStream)?.needsValidation).toBe(true);
  });

  test('does not infer for manual selection, audio, low ceilings, or unknown paths', () => {
    setConfig({ forceMax: true, forcedId: 's0-5' });
    expect(getInferredMaxCandidate(SEGMENT_URL)).toBeNull();

    setConfig({ forceMax: true, forcedId: null });
    expect(getInferredMaxCandidate(SEGMENT_URL.replace('ot%3Dv', 'ot%3Da'))).toBeNull();
    expect(getInferredMaxCandidate(SEGMENT_URL.replace('tb%3D5812', 'tb%3D3000'))).toBeNull();
    expect(getInferredMaxCandidate('https://host/video/seg_56.m4s?CMCD=br%3D1802%2Ctb%3D5812')).toBeNull();
    expect(getInferredMaxCandidate(LEGACY_CBS_PLAIN_TIER_URL.replace(LEGACY_CBS_VOD_HOST, 'unknown.example'))).toBeNull();
    expect(getInferredMaxCandidate(SEGMENT_URL.replace('vod.pplus.paramount.tech', 'unrelated.example'))).toBeNull();
    expect(getInferredMaxCandidate(SEGMENT_URL.replace('asset_cenc_precon_dash', 'unrecognized_path'))).toBeNull();
    expect(getInferredMaxCandidate(LEGACY_CBS_PLAIN_TIER_URL.replace('_2100/', '_9999/'))).toBeNull();
  });

  test('manifest representations remain authoritative', () => {
    setRepresentations([{ id: '1080p', height: 1080, source: 'manifest' }]);
    expect(getInferredMaxCandidate(SEGMENT_URL)).toBeNull();
  });
});
