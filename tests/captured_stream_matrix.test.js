import { beforeEach, describe, expect, test } from '@jest/globals';
import { getInferredMaxCandidate, resetInferredFallbackState } from '../injected/rewriter.js';
import { setConfig, setRepresentations } from '../injected/state.js';

const cmcd = '?CMCD=br%3D2000%2Cot%3Dv%2Ctb%3D8000';

const capturedVodStreams = [
  {
    title: 'Avatar Aang',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2026/05/12/ALVE01KRF3YJMCEJB92T78193MJ4HP/4309863_cenc_precon_dash/PPUSA_AVATARLASTAIRBENDER_MOVIE_UHD_V1_c24_540p_4309720_2000/seg_180.m4s',
    expected: 'PPUSA_AVATARLASTAIRBENDER_MOVIE_UHD_V1_c20_1080p_4309720_5400'
  },
  {
    title: 'Starfleet Academy S1E1',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2025/11/18/2467171907561/3598074_cenc_precon_dash/PPUSA_STARTREKSA_101_UHD_c24_540p_3589459_2000/seg_32.m4s',
    expected: 'PPUSA_STARTREKSA_101_UHD_c20_1080p_3589459_5400'
  },
  {
    title: 'Strange New Worlds S1E1',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2022/04/22/2025848387608/3444320_cenc_precon_dash/STAR_TREK_ST_101_UHD_SDR_ProRes_422hq_2398_51_LtRt_20220502_R2_Corrected_c24_540p_3185311_2000/seg_10.m4s',
    expected: 'STAR_TREK_ST_101_UHD_SDR_ProRes_422hq_2398_51_LtRt_20220502_R2_Corrected_c20_1080p_3185311_5400'
  },
  {
    title: 'Strange New Worlds S4E1',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2026/02/27/VRRyMcdzYcmaxuxl8dBdz7ywPbIKxR_Z/4270767_cenc_precon_dash/PPUSA_STARTREKSTRANGENEWWORLDS_401_V1_c24_540p_4270756_2000/seg_18.m4s',
    expected: 'PPUSA_STARTREKSTRANGENEWWORLDS_401_V1_c20_1080p_4270756_5400'
  },
  {
    title: 'Survivor S50E8',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2026/02/25/V2Qj7a_IhC8VoKNNQ9WxqGjbwF7GrBZg/3820173_cenc_precon_dash/PPUSA_SURVIVOR_5008_V1_c24_540p_3820071_2000/seg_14.m4s',
    expected: 'PPUSA_SURVIVOR_5008_V1_c23_1080p_3820071_5400'
  },
  {
    title: 'The Wolf of Wall Street',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2021/05/27/1902189635722/3055194_cenc_precon_dash/WOLF_OF_WALL_STREET_THE_36001_001_FTR_VMASTER_M3497_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_5005024386_c24_540p_3054956_2000/seg_45.m4s',
    expected: 'WOLF_OF_WALL_STREET_THE_36001_001_FTR_VMASTER_M3497_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_5005024386_c23_1080p_3054956_5400'
  },
  {
    title: 'Sleepy Hollow',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2019/01/25/1432125507781/2725042_cenc_precon_dash/Sleepy_Hollow_32962_001_FTR_VMASTER_M3497_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_5005095383_2725014_2100/seg_1.m4s',
    expected: 'Sleepy_Hollow_32962_001_FTR_VMASTER_M3497_ProRes_422_HQ_3840x2160_2398_5_1_2_0_16x9LB_engAU_engPT_5005095383_2725014_4500'
  },
  {
    title: 'Mean Girls (2024)',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2024/01/05/2297393731558/2595923_cenc_precon_dash/Mean_Girls_2024_36803_3840x2160_HQ_SDR_2579365_2100/seg_4.m4s',
    expected: 'Mean_Girls_2024_36803_3840x2160_HQ_SDR_2579365_4500'
  },
  {
    title: 'Roofman',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2025/11/04/2463647811886/3465539_cenc_precon_dash/PPUSA_ROOFMAN_MOVIE_UHD_c24_540p_3465433_2000/seg_4.m4s',
    expected: 'PPUSA_ROOFMAN_MOVIE_UHD_c20_1080p_3465433_5400'
  },
  {
    title: 'NCIS Tony and Ziva S1E1',
    url: 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2025/07/01/2436849731966/3343868_cenc_precon_dash/PPUSA_NCISTONYANDZIVA_101_UHD_c24_540p_3343844_2000/seg_4.m4s',
    expected: 'PPUSA_NCISTONYANDZIVA_101_UHD_c20_1080p_3343844_5400'
  },
  {
    title: 'The Madison S1E4',
    url: 'https://vod.pplus.paramount.tech/intl_vms/2026/02/12/3CLc3H89J48USOj146WgpHpqzHWcpVpD/3772149_cenc_precon_dash/PARPUS_THEMADISON_104_V2_c24_540p_3772056_2000/seg_4.m4s',
    expected: 'PARPUS_THEMADISON_104_V2_c20_1080p_3772056_5400'
  }
];

describe('Captured Paramount playback matrix', () => {
  beforeEach(() => {
    setRepresentations([]);
    setConfig({ forceMax: true, forcedId: null });
    resetInferredFallbackState();
  });

  test.each(capturedVodStreams)('$title produces its freshly validated max candidate', ({ url, expected }) => {
    const candidate = getInferredMaxCandidate(url + cmcd);
    expect(candidate).toEqual(expect.objectContaining({
      action: 'inferred-probe',
      source: 'inferred'
    }));
    expect(candidate.url).toContain(expected);
  });

  test.each(capturedVodStreams)('$title keeps its initialization on the max representation', ({ url, expected }) => {
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
