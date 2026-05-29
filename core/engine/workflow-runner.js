const WORKFLOWS = {
  standard: {
    full: ["plan", "execute", "verify"],
    light: ["plan", "execute"],
    none: ["execute", "verify"],
    parent: ["plan"],
  },
  complex: {
    full: ["plan", "execute", "verify"],
    light: ["plan", "execute"],
    none: ["execute", "verify"],
    parent: ["plan"],
  },
  review: {
    full: ["review"],
  },
  repair: {
    full: ["repair"],
  },
};

export function resolvePhases(workflow = "standard", planMode = "full") {
  const wf = WORKFLOWS[workflow] || WORKFLOWS.standard;
  return wf[planMode] || wf.full || ["plan", "execute", "verify"];
}
