export function phasePassed({ phase, artifact = null, diagnostics = {} }) {
    return {
        schemaVersion: 1,
        phase,
        status: "passed",
        artifact,
        failure: null,
        diagnostics,
        createdAt: new Date().toISOString(),
    };
}
export function phaseFailed({ phase, failure, diagnostics = {} }) {
    return {
        schemaVersion: 1,
        phase,
        status: "failed",
        artifact: null,
        failure,
        diagnostics,
        createdAt: new Date().toISOString(),
    };
}
export function isPhasePassed(result) {
    return result?.status === "passed";
}
