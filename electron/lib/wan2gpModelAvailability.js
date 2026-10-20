// Availability of a Wan2GP catalog model for the configured engine.
//
// engine = { ok, error, mode: 'local' | 'remote', modelStatus: Map<modelType, status> }
//   local:  from <Wan2GP>/defaults/<modelType>.json + ckpts/ (see wan2gpLocal.localModelStatus)
//   remote: from WanGP's MCP `wangp_get_model_availability`
//   both:   'available' | 'missing' | 'installed'; anything else means the model is unknown
// Weights that are not on disk yet are still usable — Wan2GP downloads them on
// first use — so that case is ready with a note, not unavailable.
const { rateFit, shouldDemoteLegacy } = require('./wan2gpFit');

function withWan2gpAvailability(model, engine) {
    if (!engine?.ok) {
        return { ...model, ready: false, unavailableReason: engine?.error || 'Wan2GP is not configured' };
    }

    const status = engine.modelStatus?.get(model.modelType);
    const needsDownload = status === 'missing';

    // Hardware fit only applies to a local engine: a remote server has its own GPU.
    const rated = engine.mode === 'local' && engine.hardware && (status === 'installed' || status === 'available' || status === 'missing')
        ? rateFit(model.modelType, engine.hardware, { needsDownload })
        : null;
    if (rated?.fit === 'unfit') {
        return { ...model, ready: false, fit: 'unfit', unavailableReason: rated.reason, downloadGB: rated.downloadGB };
    }
    const fitInfo = {
        ...(rated && rated.fit !== 'unknown' ? { fit: rated.fit, fitReason: rated.reason, downloadGB: rated.downloadGB } : {}),
        ...(model.legacy ? { legacyDemoted: shouldDemoteLegacy(engine.hardware) } : {}),
    };

    if (status === 'installed' || status === 'available') {
        // 'available' = weight files found in ckpts/; 'installed' = defined, files unknown.
        return { ...model, ready: true, ...fitInfo, ...(status === 'available' ? { downloaded: true } : {}) };
    }
    if (status === 'missing') {
        const size = rated?.downloadGB ? `~${rated.downloadGB} GB` : 'several GB';
        return { ...model, ready: true, ...fitInfo, needsDownload: true, availabilityNote: `Not downloaded yet — the first run downloads ${size}.` };
    }

    const where = engine.mode === 'remote' ? 'The Wan2GP server' : 'This Wan2GP install';
    return {
        ...model,
        ready: false,
        unavailableReason: `${where} has no model "${model.modelType}" — update Wan2GP.`,
    };
}

module.exports = { withWan2gpAvailability };
