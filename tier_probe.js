// Tier Discovery Probe - Run this in browser console on Paramount+ page
// Copy a working segment URL first, then paste it below

const baseUrl = 'https://vod-gcs-cedexis.cbsaavideo.com/intl_vms/2021/07/08/1919384643634/2418012_cenc_precon_dash/PARAMOUNT_STAR_TREK_INTO_DARKNESS_FTR_km_2398_8CH_731210_TIER/seg_46.m4s';

async function probeTiers() {
    const results = [];

    // Try from 12500 down to 500, stepping by 500
    for (let tier = 12500; tier >= 500; tier -= 500) {
        const url = baseUrl.replace('_TIER/', `_${tier}/`);

        try {
            const response = await fetch(url, { method: 'HEAD' });
            const status = response.status;
            const result = { tier, status, exists: response.ok };
            results.push(result);

            if (response.ok) {
                console.log(`✅ ${tier} kbps - EXISTS (${status})`);
            } else {
                console.log(`❌ ${tier} kbps - ${status}`);
            }
        } catch (err) {
            console.log(`⚠️ ${tier} kbps - ERROR: ${err.message}`);
            results.push({ tier, status: 'error', exists: false });
        }

        // Small delay to avoid hammering the server
        await new Promise(r => setTimeout(r, 100));
    }

    console.log('\n=== SUMMARY: Available Tiers ===');
    const available = results.filter(r => r.exists);
    available.forEach(r => console.log(`${r.tier} kbps`));

    return available;
}

// Run it
probeTiers();
