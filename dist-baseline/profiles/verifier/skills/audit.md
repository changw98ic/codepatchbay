---
name: audit
description: Security audit checklist based on OWASP Top 10
---

## Instructions
Review the codebase against OWASP Top 10 categories:

1. **A01 Broken Access Control**: Check authorization checks, role enforcement, IDOR
2. **A02 Cryptographic Failures**: Hardcoded secrets, weak algorithms, plaintext storage
3. **A03 Injection**: SQL, command, LDAP, XSS — check all user input paths
4. **A04 Insecure Design**: Missing threat modeling, insecure defaults
5. **A05 Security Misconfiguration**: Debug mode, default credentials, verbose errors
6. **A06 Vulnerable Components**: Outdated deps, known CVEs
7. **A07 Auth Failures**: Weak passwords, missing MFA, session fixation
8. **A08 Data Integrity**: Deserialization, unsigned updates, CI/CD pipeline integrity
9. **A09 Logging Failures**: Missing audit logs, log injection, sensitive data in logs
10. **A10 SSRF**: Unvalidated URLs, internal network access

For each category: PASS, FAIL, or N/A with evidence.

## Output Format
### Security Audit Results
- **Categories Passed**: {n}/10
- **Categories Failed**: {n}/10
- **Categories N/A**: {n}/10

### Findings

| Category | Status | Evidence |
|----------|--------|----------|
| A01 Broken Access Control | PASS/FAIL/N/A | {details} |
| A02 Cryptographic Failures | PASS/FAIL/N/A | {details} |
| ... | ... | ... |

### Critical Findings
- **{category}**: {finding}
  - **Location**: {file}:{line}
  - **Risk**: {severity}
  - **Remediation**: {fix}
