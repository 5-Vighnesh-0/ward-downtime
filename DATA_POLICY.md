# Data Policy

1. **Synthetic only.** Every patient name, ID and record in this repo, tests, demos, screenshots and videos is made up.
2. **Allowed sources:** Synthea output, @faker-js/faker, hand-written fake names.
3. **Not allowed:** real names, MRNs, DOBs, SSNs, phone numbers, emails, addresses, photos, or anything copied from a real system, even "anonymized".
4. **Fake IDs must look fake:** temporary IDs use the pattern `T-<device>-<n>`. No real-format SSN or MRN patterns.
5. **CI check:** a script scans the repo for real-looking identifiers and fails the build.
6. **Demos and interviews:** say clearly the data is synthetic. Never show a real hospital's screen or data.
7. **Pilot with a real hospital** would need a separate risk analysis, legal review and approvals before any real data. Out of scope.
8. **No compliance claims.** Say "designed toward HIPAA safeguards", never "HIPAA compliant".
