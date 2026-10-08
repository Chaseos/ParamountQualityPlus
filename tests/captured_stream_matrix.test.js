import { beforeEach, describe, expect, test } from '@jest/globals';
import { getInferredMaxCandidate, resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

// Capture-derived URL shapes; all asset identifiers and paths are synthetic.
const cmcd = '?CMCD=br%3D2000%2Cot%3Dv%2Ctb%3D8000';

const anonymizedVodStreams = [
  {
    title: 'Modern UHD movie',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_02/1000003_cenc_precon_dash/SAMPLE_MOVIE_UHD_V1_c24_540p_2000004_2000/seg_180.m4s',
    expected: 'SAMPLE_MOVIE_UHD_V1_c20_1080p_2000004_5400'
  },
  {
    title: 'Modern UHD series A',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_03/1000004_cenc_precon_dash/SAMPLE_SERIES_A_101_UHD_c24_540p_2000005_2000/seg_32.m4s',
    expected: 'SAMPLE_SERIES_A_101_UHD_c20_1080p_2000005_5400'
  },
  {
    title: 'Mastered UHD series',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_04/1000005_cenc_precon_dash/SAMPLE_MASTERED_SERIES_101_UHD_SDR_ProRes_422hq_2398_51_LtRt_20000101_R2_c24_540p_2000007_2000/seg_10.m4s',
    expected: 'SAMPLE_MASTERED_SERIES_101_UHD_SDR_ProRes_422hq_2398_51_LtRt_20000101_R2_c20_1080p_2000007_5400'
  },
  {
    title: 'Modern series B',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_05/1000006_cenc_precon_dash/SAMPLE_SERIES_B_101_V1_c24_540p_2000008_2000/seg_18.m4s',
    expected: 'SAMPLE_SERIES_B_101_V1_c20_1080p_2000008_5400'
  },
  {
    title: 'Survivor profile',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_06/1000007_cenc_precon_dash/SAMPLE_SURVIVOR_101_V1_c24_540p_2000009_2000/seg_14.m4s',
    expected: 'SAMPLE_SURVIVOR_101_V1_c23_1080p_2000009_5400'
  },
  {
    title: 'Legacy mastered movie',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2000/01/01/EXAMPLE_EPISODE_07/1000008_cenc_precon_dash/SAMPLE_MOVIE_90001_001_FTR_VMASTER_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_9000000001_c24_540p_2000012_2000/seg_45.m4s',
    expected: 'SAMPLE_MOVIE_90001_001_FTR_VMASTER_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_9000000001_c23_1080p_2000012_5400'
  },
  {
    title: 'Legacy plain-tier movie',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2000/01/01/EXAMPLE_EPISODE_08/1000009_cenc_precon_dash/SAMPLE_PLAIN_MOVIE_90002_001_FTR_VMASTER_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_9000000002_2000015_2100/seg_1.m4s',
    expected: 'SAMPLE_PLAIN_MOVIE_90002_001_FTR_VMASTER_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_9000000002_2000015_4500'
  },
  {
    title: 'Modern plain-tier movie',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2099/01/01/EXAMPLE_EPISODE_09/1000010_cenc_precon_dash/SAMPLE_PLAIN_MOVIE_B_2099_90003_3840x2160_HQ_SDR_2000017_2100/seg_4.m4s',
    expected: 'SAMPLE_PLAIN_MOVIE_B_2099_90003_3840x2160_HQ_SDR_2000017_4500'
  },
  {
    title: 'Modern UHD movie B',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_10/1000011_cenc_precon_dash/SAMPLE_MOVIE_B_UHD_c24_540p_2000018_2000/seg_4.m4s',
    expected: 'SAMPLE_MOVIE_B_UHD_c20_1080p_2000018_5400'
  },
  {
    title: 'Modern series on CBS CDN',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2099/01/01/EXAMPLE_EPISODE_11/1000012_cenc_precon_dash/SAMPLE_SERIES_C_101_UHD_c24_540p_2000019_2000/seg_4.m4s',
    expected: 'SAMPLE_SERIES_C_101_UHD_c20_1080p_2000019_5400'
  },
  {
    title: 'Modern series D',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2099/01/01/EXAMPLE_EPISODE_12/1000013_cenc_precon_dash/SAMPLE_SERIES_D_101_V2_c24_540p_2000020_2000/seg_4.m4s',
    expected: 'SAMPLE_SERIES_D_101_V2_c20_1080p_2000020_5400'
  }
];

describe('Anonymized capture-derived Paramount playback matrix', () => {
  beforeEach(() => {
    setRepresentations([]);
    setConfig({ forceMax: true, forcedId: null });
    resetInferredFallbackState();
  });

  test.each(anonymizedVodStreams)('$title produces its expected max candidate', ({ url, expected }) => {
    const candidate = getInferredMaxCandidate(url + cmcd);
    expect(candidate).toEqual(expect.objectContaining({
      action: 'inferred-probe',
      source: 'inferred'
    }));
    expect(candidate.url).toContain(expected);
  });

  test.each(anonymizedVodStreams)('$title keeps its initialization on the max representation', ({ url, expected }) => {
    const initializationUrl = url.replace(/\/seg_\d+\.m4s$/, '/init.m4v');
    const candidate = getInferredMaxCandidate(initializationUrl + '?CMCD=ot%3Di');

    expect(candidate).toEqual(expect.objectContaining({
      action: 'inferred-probe',
      mediaRole: 'initialization',
      source: 'inferred'
    }));
    expect(candidate.url).toContain(`${expected}/init.m4v`);
  });
});
